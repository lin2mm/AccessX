const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { authStatus, createAuth } = require('./auth');

function request(auth, { method = 'POST', authorization, ip = '127.0.0.1' } = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let passed = false;
  auth(
    {
      method,
      headers: { authorization },
      socket: { remoteAddress: ip },
    },
    response,
    () => {
      passed = true;
    },
  );
  return { passed, ...response };
}

test('allows public read-only requests when open reads are enabled', () => {
  const auth = createAuth({ token: '', openReads: true });
  assert.equal(request(auth, { method: 'GET' }).passed, true);
  assert.equal(request(auth, { method: 'HEAD' }).passed, true);
});

test('fails closed on writes when ADMIN_TOKEN is not configured', () => {
  const auth = createAuth({ token: '', openReads: true });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const result = request(auth, { method });
    assert.equal(result.passed, false);
    assert.equal(result.statusCode, 503);
    assert.match(result.body.error, /ADMIN_TOKEN/);
  }
});

test('fails closed on protected reads when ADMIN_TOKEN is not configured', () => {
  const result = request(createAuth({ token: '', openReads: false }), { method: 'GET' });
  assert.equal(result.passed, false);
  assert.equal(result.statusCode, 503);
  assert.match(result.body.error, /API access/);
});

test('requires a valid bearer token for writes', () => {
  const auth = createAuth({ token: 'correct-token', openReads: true });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal(request(auth, { method, authorization: 'Bearer wrong-token' }).statusCode, 401);
    assert.equal(request(auth, { method, authorization: 'Bearer correct-token' }).passed, true);
  }
});

test('protects reads when openReads is disabled', () => {
  const auth = createAuth({ token: 'correct-token', openReads: false });
  assert.equal(request(auth, { method: 'GET' }).statusCode, 401);
  assert.equal(request(auth, { method: 'GET', authorization: 'Bearer correct-token' }).passed, true);
});

test('rate-limits failed attempts without locking out a valid token', () => {
  const auth = createAuth({ token: 'correct-token', maxFails: 2 });
  assert.equal(request(auth, { authorization: 'Bearer wrong', ip: 'test-client' }).statusCode, 401);
  assert.equal(request(auth, { authorization: 'Bearer wrong', ip: 'test-client' }).statusCode, 429);
  assert.equal(request(auth, { authorization: 'Bearer correct-token', ip: 'test-client' }).passed, true);
  assert.equal(request(auth, { authorization: 'Bearer wrong', ip: 'test-client' }).statusCode, 401);
});

test('mounts authentication before API routes, including token verification', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const statusRoute = server.indexOf("app.get('/api/auth'");
  const middleware = server.indexOf("app.use('/api', requireAuth)");
  const verifyRoute = server.indexOf("app.post('/api/auth/verify'");
  assert.ok(statusRoute !== -1 && statusRoute < middleware);
  assert.ok(verifyRoute > middleware);
  assert.match(
    server,
    /openReads:\s*process\.env\.AUTH_OPEN_READS === undefined\s*\?\s*DEMO\s*:/,
  );
});

test('reports read-only and locked auth states accurately', () => {
  assert.equal(authStatus({ token: '', openReads: true }).mode, 'DEMO-READ-ONLY');
  assert.equal(authStatus({ token: '', openReads: false }).mode, 'LOCKED');
  assert.equal(authStatus({ token: 'configured', openReads: false }).mode, 'TOKEN');
  assert.equal(authStatus({ token: 'configured', openReads: false }).tokenConfigured, true);
});
