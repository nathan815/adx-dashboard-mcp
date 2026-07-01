import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ExtensionBroker } from './extension-broker.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.terminated = false;
    this.closed = false;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  receive(message) {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
}

test('registers extension sockets by dashboard and instance', () => {
  let now = 1000;
  const broker = new ExtensionBroker({ now: () => now });
  const socket = new FakeSocket();
  broker.addSocket(socket);

  socket.receive({
    type: 'register',
    dashboardId: 'dash-1',
    instanceId: 'tab-1',
    title: 'Dashboard',
    agentVersion: '1.2.3',
  });

  assert.deepEqual(broker.listDashboards(), [{
    id: 'dash-1',
    title: 'Dashboard',
    connectedAt: 1000,
    instanceCount: 1,
    agentVersion: '1.2.3',
  }]);
  assert.equal(socket.sent.at(-1).type, 'registered');

  now = 2000;
  socket.close();
  assert.deepEqual(broker.listDashboards(), []);
});

test('delivers queued commands to a matching socket and resolves from result', async () => {
  const broker = new ExtensionBroker({ heartbeatIntervalMs: 1000, heartbeatGraceMs: 5000 });
  const socket = new FakeSocket();
  broker.addSocket(socket);
  socket.receive({ type: 'register', dashboardId: 'dash-1', instanceId: 'tab-1' });

  const queued = broker.queueCommand('dash-1', 'getDashboard', {}, 1000);
  const command = socket.sent.find((message) => message.type === 'command');
  assert.equal(command.kind, 'getDashboard');
  assert.equal(command.dashboardId, 'dash-1');

  socket.receive({ type: 'result', id: command.id, result: { ok: true } });
  assert.deepEqual(await queued, { commandId: command.id, result: { ok: true } });
  assert.equal(broker.pendingCount(), 0);
});

test('holds queued commands until a matching socket registers', async () => {
  const broker = new ExtensionBroker();
  const queued = broker.queueCommand('dash-1', 'action', { type: 'refresh', params: {} }, 1000);

  const socket = new FakeSocket();
  broker.addSocket(socket);
  socket.receive({ type: 'register', dashboardId: 'dash-1', instanceId: 'tab-1' });

  const command = socket.sent.find((message) => message.type === 'command');
  assert.equal(command.kind, 'action');

  socket.receive({ type: 'result', id: command.id, result: { success: true } });
  assert.deepEqual(await queued, { commandId: command.id, result: { success: true } });
});

test('routes dashboard-specific commands only to matching dashboards', async () => {
  const broker = new ExtensionBroker();
  const socketA = new FakeSocket();
  const socketB = new FakeSocket();
  broker.addSocket(socketA);
  broker.addSocket(socketB);
  socketA.receive({ type: 'register', dashboardId: 'dash-a', instanceId: 'tab-a' });
  socketB.receive({ type: 'register', dashboardId: 'dash-b', instanceId: 'tab-b' });

  const queued = broker.queueCommand('dash-b', 'action', { type: 'getErrors', params: {} }, 1000);

  assert.equal(socketA.sent.some((message) => message.type === 'command'), false);
  assert.equal(socketB.sent.some((message) => message.type === 'command'), true);

  const command = socketB.sent.find((message) => message.type === 'command');
  socketB.receive({ type: 'result', id: command.id, result: { errors: [] } });
  assert.deepEqual(await queued, { commandId: command.id, result: { errors: [] } });
});

test('serializes commands per socket until the in-flight result arrives', async () => {
  const broker = new ExtensionBroker();
  const socket = new FakeSocket();
  broker.addSocket(socket);
  socket.receive({ type: 'register', dashboardId: 'dash-1', instanceId: 'tab-1' });

  const firstQueued = broker.queueCommand('dash-1', 'action', { type: 'refresh', params: {} }, 1000);
  const secondQueued = broker.queueCommand('dash-1', 'edit', { dashboard: {} }, 1000);

  let commands = socket.sent.filter((message) => message.type === 'command');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].kind, 'action');

  socket.receive({ type: 'result', id: commands[0].id, result: { success: true } });
  assert.deepEqual(await firstQueued, { commandId: commands[0].id, result: { success: true } });

  commands = socket.sent.filter((message) => message.type === 'command');
  assert.equal(commands.length, 2);
  assert.equal(commands[1].kind, 'edit');

  socket.receive({ type: 'result', id: commands[1].id, result: { success: true } });
  assert.deepEqual(await secondQueued, { commandId: commands[1].id, result: { success: true } });
});

test('fails an in-flight command when its socket closes before result', async () => {
  const broker = new ExtensionBroker();
  const socket = new FakeSocket();
  broker.addSocket(socket);
  socket.receive({ type: 'register', dashboardId: 'dash-1', instanceId: 'tab-1' });

  const queued = broker.queueCommand('dash-1', 'edit', { dashboard: {} }, 1000);
  const command = socket.sent.find((message) => message.type === 'command');
  socket.close();

  assert.deepEqual(await queued, {
    commandId: command.id,
    result: {
      success: false,
      error: 'Browser connection closed before the command completed. Re-run the operation after the extension reconnects.',
    },
  });
  assert.equal(broker.pendingCount(), 0);
});

test('evicts sockets that miss heartbeat responses', () => {
  let now = 1000;
  const broker = new ExtensionBroker({
    now: () => now,
    heartbeatIntervalMs: 100,
    heartbeatGraceMs: 500,
  });
  const socket = new FakeSocket();
  broker.addSocket(socket);
  socket.receive({ type: 'register', dashboardId: 'dash-1', instanceId: 'tab-1' });

  now = 1200;
  broker.checkHeartbeat();
  assert.equal(socket.sent.at(-1).type, 'ping');

  now = 2000;
  broker.checkHeartbeat();
  assert.equal(socket.terminated, true);
  assert.deepEqual(broker.listDashboards(), []);
});
