const test = require('node:test');
const assert = require('node:assert/strict');
const { checkWebhookUrl } = require('../audit-ops');
const { createOidcClient } = require('../oidc-core');

const allowed = u => { try { checkWebhookUrl(u); return true; } catch { return false; } };

test('webhook URLs: private IPv4 hidden in IPv6 literals is refused', () => {
  for (const u of ['https://[::ffff:127.0.0.1]/x', 'https://[::ffff:a9fe:a9fe]/latest/meta-data', 'https://[::]/x', 'https://[::1]/x', 'https://[::7f00:1]/x',
    'https://[64:ff9b::a00:1]/x', 'https://[fd12::1]/x', 'https://[fe80::1]/x', 'https://10.0.0.1/x', 'https://127.1/x', 'https://2130706433/x', 'https://metadata.google.internal/x']) {
    assert.equal(allowed(u), false, u);
  }
  for (const u of ['https://hooks.slack.com/services/T/B/x', 'https://[::ffff:8.8.8.8]/x', 'https://[2606:4700::1111]/x', 'https://[64:ff9b::808:808]/x']) assert.equal(allowed(u), true, u);
});

test('OIDC client: refuses private or plain-http endpoints named by a discovery document, never follows redirects', async () => {
  const ISS = 'https://idp.example';
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, redirect: init && init.redirect });
    const body = { issuer: ISS, authorization_endpoint: `${ISS}/auth`, token_endpoint: 'http://idp.example/token', jwks_uri: 'https://[::ffff:a9fe:a9fe]/keys' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const c = createOidcClient({ fetchFn });
  const doc = await c.discover(ISS);
  assert.equal(seen[0].redirect, 'manual');
  assert.ok(doc.jwks_uri);
  await assert.rejects(c.exchangeCode({ config: { issuer: ISS, clientId: 'c' }, code: 'x', redirectUri: 'https://doors.example/cb', codeVerifier: 'v' }), /must use https/);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  await assert.rejects(c.verifyIdToken(`${header}.e30.x`, { issuer: ISS, clientId: 'c', nonce: 'n' }), /public address/);
  assert.equal(seen.length, 1, 'neither the metadata address nor the http endpoint was fetched');
  await assert.rejects(createOidcClient({ fetchFn }).discover('https://10.1.2.3'), /public address/);
  assert.ok(await createOidcClient({ fetchFn, allowPrivate: true }).discover(ISS), 'development deployments (ALLOW_HTTP_ISSUERS / MOCK_IDP) keep working');
});
