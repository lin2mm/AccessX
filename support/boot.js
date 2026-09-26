// Boots server.js in-process against a throwaway DATA_DIR and returns a
// tiny fetch helper. Each call to boot() gets a fresh module + data dir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function boot(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessx-'));
  const saved = { ...process.env };
  for (const key of ['ADMIN_TOKEN', 'AUTH_OPEN_READS', 'OPERATORS', 'TTLOCK_CLIENT_ID']) delete process.env[key];
  Object.assign(process.env, { DATA_DIR: dataDir, ...env });
  for (const key of Object.keys(require.cache)) {
    if (!key.includes('node_modules')) delete require.cache[key];
  }
  const { app } = require('../server');
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env = saved;
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, url, { token, body } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  return {
    call,
    base,
    dataDir,
    close: () => new Promise(resolve => server.close(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      resolve();
    })),
  };
}

module.exports = { boot };
