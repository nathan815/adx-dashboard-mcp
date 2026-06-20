// Minimal express-style router with no external dependencies. A pattern like
// '/dashboards/:id/tiles/:tileId' compiles to a regex; the :segments are
// captured, decoded, and handed to the handler as ctx.params. Routes are
// matched in registration order, first hit wins.
export function createRouter() {
  const routes = [];

  function route(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    }) + '$');
    routes.push({ method, regex, keys, handler });
  }

  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.regex);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }

  return { route, match };
}
