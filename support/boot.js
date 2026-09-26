// Boots server.js in-process against a throwaway DATA_DIR and returns a
// tiny fetch helper. Each call to boot() gets a fresh module + data dir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function boot(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessx-'));
  const saved = { ...process.env };
  for (const key of ['ADMIN_TOKEN', 'AUTH_OPEN_READS', 'OPERATORS', 'TTLOCK_CLIENT_ID', 'PLATFORM_TOKEN']) delete process.env[key];
  Object.assign(process.env, { DATA_DIR: dataDir, ...env });
  for (const key of Object.keys(require.cache)) {
    if (!key.includes('node_modules')) delete require.cache[key];
  }
  const mod = require('../server');
  const { app } = mod;
  await mod.api.whenReady();
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env = saved;
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, url, { token, body, headers: extra = {}, contentType = 'application/json' } = {}) {
    const headers = { ...extra };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = contentType;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers, cookies: res.headers.getSetCookie() };
  }
  return {
    call,
    base,
    server: mod, // { app, api, store } — for tests that need to reach below HTTP
    dataDir,
    close: () => new Promise(resolve => server.close(() => {
      mod.store.sql.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
      resolve();
    })),
  };
}

module.exports = { boot };
