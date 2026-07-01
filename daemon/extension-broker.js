import { randomUUID } from 'node:crypto';

export const EXTENSION_WS_PATH = '/extension';
export const EXTENSION_ORIGIN = 'https://dataexplorer.azure.com';

const SOCKET_OPEN = 1;

function socketIsOpen(socket) {
  return socket && (socket.readyState === undefined || socket.readyState === SOCKET_OPEN);
}

function sendMessage(socket, message) {
  if (!socketIsOpen(socket)) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

export class ExtensionBroker {
  constructor({
    log = () => {},
    now = () => Date.now(),
    heartbeatIntervalMs = 15000,
    heartbeatGraceMs = 45000,
  } = {}) {
    this.log = log;
    this.now = now;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatGraceMs = heartbeatGraceMs;
    this.connectedDashboards = new Map();
    this.sockets = new Map();
    this.pendingCommands = new Map();
    this.heartbeatTimer = null;
  }

  addSocket(socket) {
    this.sockets.set(socket, {
      socket,
      dashboardId: null,
      instanceId: null,
      title: 'Untitled',
      agentVersion: null,
      connectedAt: this.now(),
      lastSeenAt: this.now(),
      lastPingAt: 0,
      inFlightCommandId: null,
    });

    socket.on('message', (raw) => this.handleMessage(socket, raw));
    socket.on('close', () => this.removeSocket(socket));
    socket.on('error', (err) => {
      this.log(`Extension socket error: ${err.message}`);
    });
  }

  handleMessage(socket, raw) {
    const conn = this.sockets.get(socket);
    if (conn) conn.lastSeenAt = this.now();

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return this.sendError(socket, 'invalid_json', 'Invalid WebSocket message JSON');
    }

    switch (message.type) {
      case 'register':
        return this.register(socket, message);
      case 'result':
        return this.handleResult(socket, message);
      case 'pong':
        return;
      default:
        return this.sendError(socket, 'unknown_message_type', `Unknown message type: ${message.type}`);
    }
  }

  register(socket, message) {
    const { dashboardId, title, agentVersion } = message;
    const instanceId = message.instanceId || dashboardId;
    if (!dashboardId) {
      return this.sendError(socket, 'missing_dashboard_id', 'Missing dashboardId');
    }

    this.unregisterSocket(socket);

    const conn = this.sockets.get(socket);
    if (!conn) return;
    conn.dashboardId = dashboardId;
    conn.instanceId = instanceId;
    conn.title = title || 'Untitled';
    conn.agentVersion = agentVersion || null;
    conn.connectedAt = this.now();
    conn.lastSeenAt = this.now();

    let instances = this.connectedDashboards.get(dashboardId);
    if (!instances) {
      instances = new Map();
      this.connectedDashboards.set(dashboardId, instances);
    }
    instances.set(instanceId, conn);

    this.log(`Extension connected: ${dashboardId} "${conn.title}" (instance ${instanceId}, agent ${agentVersion || 'unknown'})`);
    if (!sendMessage(socket, { type: 'registered', dashboardId, instanceId })) {
      this.log(`Failed to acknowledge extension registration: ${dashboardId} (instance ${instanceId})`);
    }
    this.dispatchPending();
  }

  unregisterSocket(socket) {
    const conn = this.sockets.get(socket);
    if (!conn || !conn.dashboardId || !conn.instanceId) return;

    const instances = this.connectedDashboards.get(conn.dashboardId);
    if (instances && instances.get(conn.instanceId) === conn) {
      instances.delete(conn.instanceId);
      if (instances.size === 0) this.connectedDashboards.delete(conn.dashboardId);
    }
    conn.dashboardId = null;
    conn.instanceId = null;
  }

  removeSocket(socket) {
    const conn = this.sockets.get(socket);
    if (conn?.dashboardId) {
      this.log(`Extension disconnected: ${conn.dashboardId} (instance ${conn.instanceId})`);
    }
    this.failCommandsDeliveredTo(conn);
    this.unregisterSocket(socket);
    this.sockets.delete(socket);
  }

  failCommandsDeliveredTo(conn) {
    if (!conn) return;
    for (const [id, command] of this.pendingCommands) {
      if (command.deliveredTo !== conn) continue;
      this.finishCommand(command);
      command.resolve({
        success: false,
        error: 'Browser connection closed before the command completed. Re-run the operation after the extension reconnects.',
      });
    }
  }

  instancesFor(dashboardId) {
    const instances = this.connectedDashboards.get(dashboardId);
    return instances ? Array.from(instances.values()).map((conn) => ({
      instanceId: conn.instanceId,
      title: conn.title,
      agentVersion: conn.agentVersion,
      connectedAt: conn.connectedAt,
    })) : [];
  }

  listDashboards() {
    const dashboards = [];
    for (const [dashboardId, instances] of this.connectedDashboards) {
      const list = Array.from(instances.values());
      const first = list[0] || {};
      dashboards.push({
        id: dashboardId,
        title: first.title || 'Untitled',
        connectedAt: first.connectedAt || null,
        instanceCount: list.length,
        agentVersion: first.agentVersion || null,
      });
    }
    return dashboards;
  }

  pendingCount() {
    return this.pendingCommands.size;
  }

  queueCommand(dashboardId, kind, payload = {}, timeoutMs = 10000) {
    const id = randomUUID();
    const command = {
      id,
      dashboardId: dashboardId || '*',
      kind,
      payload,
      deliveredTo: null,
      createdAt: this.now(),
      expiresAt: payload.expiresAt || this.now() + timeoutMs,
      timer: null,
      resolve: null,
    };

    const resultPromise = new Promise((resolve) => {
      command.resolve = resolve;
      command.timer = setTimeout(() => {
        this.finishCommand(command);
        resolve({ timeout: true });
        this.dispatchPending();
      }, timeoutMs);
    });
    this.pendingCommands.set(id, command);
    this.dispatchPending();

    return resultPromise.then((result) => ({ commandId: id, result }));
  }

  dispatchPending() {
    for (const command of this.pendingCommands.values()) {
      if (command.deliveredTo) continue;
      const conn = this.findConnection(command.dashboardId);
      if (!conn) continue;
      if (conn.inFlightCommandId) continue;

      const sent = sendMessage(conn.socket, {
        type: 'command',
        id: command.id,
        dashboardId: command.dashboardId,
        kind: command.kind,
        payload: command.payload,
        expiresAt: command.expiresAt,
      });
      if (sent) {
        command.deliveredTo = conn;
        conn.inFlightCommandId = command.id;
      } else {
        this.log(`Failed to deliver extension command ${command.id} to dashboard ${conn.dashboardId}`);
      }
    }
  }

  findConnection(dashboardId) {
    if (dashboardId && dashboardId !== '*') {
      const instances = this.connectedDashboards.get(dashboardId);
      return instances ? instances.values().next().value : null;
    }
    for (const instances of this.connectedDashboards.values()) {
      const conn = instances.values().next().value;
      if (conn) return conn;
    }
    return null;
  }

  handleResult(socket, message) {
    const id = message.id || message.commandId;
    if (!id) {
      return this.sendError(socket, 'missing_command_id', 'Missing command result id');
    }
    const command = this.pendingCommands.get(id);
    if (!command) {
      return this.sendError(socket, 'unknown_command_id', 'Command not found');
    }
    this.finishCommand(command);
    command.resolve(message.result);
    this.dispatchPending();
  }

  finishCommand(command) {
    clearTimeout(command.timer);
    this.pendingCommands.delete(command.id);
    if (command.deliveredTo?.inFlightCommandId === command.id) {
      command.deliveredTo.inFlightCommandId = null;
    }
  }

  sendError(socket, code, message) {
    try {
      sendMessage(socket, { type: 'error', code, message });
    } catch (e) {
      this.log(`Failed to send extension error: ${e.message}`);
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), this.heartbeatIntervalMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  checkHeartbeat() {
    const now = this.now();
    for (const conn of Array.from(this.sockets.values())) {
      if (now - conn.lastSeenAt > this.heartbeatGraceMs) {
        this.log(`Extension heartbeat expired: ${conn.dashboardId || 'unregistered'} (instance ${conn.instanceId || 'unknown'})`);
        this.removeSocket(conn.socket);
        if (conn.socket.terminate) conn.socket.terminate();
        else if (conn.socket.close) conn.socket.close();
        continue;
      }
      if (now - conn.lastPingAt >= this.heartbeatIntervalMs) {
        conn.lastPingAt = now;
        try {
          sendMessage(conn.socket, { type: 'ping', at: now });
        } catch (e) {
          this.log(`Failed to ping extension socket: ${e.message}`);
        }
      }
    }
  }
}
