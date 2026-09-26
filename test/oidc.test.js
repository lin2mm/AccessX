const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createOidcClient, pkceChallenge } = require('../oidc-core');

const ISS = 'https://idp.example';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };

function fakeIdp({ issuer = ISS } = {}) {
  let jwksFetches = 0;
  const fetchFn = async url => {
    const body = url.endsWith('/.well-known/openid-configuration')
      ? { issuer, authorization_endpoint: `${ISS}/auth`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks` }
      : url === `${ISS}/jwks` ? (jwksFetches++, { keys: [jwk] }) : null;
    return { ok: Boolean(body), status: body ? 200 : 404, text: async () => JSON.stringify(body || {}) };
  };
  return { fetchFn, get jwksFetches() { return jwksFetches; } };
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, { header = { alg: 'RS256', kid: 'k1' }, key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(header);
  const p = b64({ iss: ISS, aud: 'client-1', sub: 'u1', nonce: 'n1', iat: now, exp: now + 300, ...claims });
  return `${h}.${p}.${crypto.sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}
const opts = { issuer: ISS, clientId: 'client-1', nonce: 'n1' };

test('valid RS256 id_token verifies', async () => {
  const c = createOidcClient({ fetchFn: fakeIdp().fetchFn });
  const claims = await c.verifyIdToken(sign({ email: 'a@x.example' }), opts);
  assert.equal(claims.sub, 'u1');
});

test('tampered, forged and mismatched tokens are rejected', async () => {
  const c = createOidcClient({ fetchFn: fakeIdp().fetchFn });
  const now = Math.floor(Date.now() / 1000);
  const good = sign({});
  const [h, , s] = good.split('.');
  const cases = {
    'payload edited after signing': `${h}.${b64({ iss: ISS, aud: 'client-1', sub: 'admin', nonce: 'n1', exp: now + 300 })}.${s}`,
    'signed by another key': sign({}, { key: attacker.privateKey }),
    'alg none': `${b64({ alg: 'none', kid: 'k1' })}.${good.split('.')[1]}.`,
    'alg HS256 (key confusion)': sign({}, { header: { alg: 'HS256', kid: 'k1' } }),
    'wrong issuer': sign({ iss: 'https://evil.example' }),
    'wrong audience': sign({ aud: 'other-client' }),
    'multi-aud with foreign azp': sign({ aud: ['client-1', 'x'], azp: 'x' }),
    'expired': sign({ exp: now - 3600 }),
    'issued in the future': sign({ iat: now + 3600 }),
    'nonce replay/mismatch': sign({ nonce: 'other' }),
    'no subject': sign({ sub: '' }),
    'unknown kid': sign({}, { header: { alg: 'RS256', kid: 'nope' } }),
    'garbage': 'a.b',
  };
  for (const [name, token] of Object.entries(cases)) {
    await assert.rejects(c.verifyIdToken(token, opts), undefined, name);
  }
});

test('discovery must name the configured issuer (mix-up defence)', async () => {
  const c = createOidcClient({ fetchFn: fakeIdp({ issuer: 'https://someone-else.example' }).fetchFn });
  await assert.rejects(c.discover(ISS), /issuer/);
});

test('unknown kid refetches JWKS at most once a minute', async () => {
  let t = Date.now();
  const idp = fakeIdp();
  const c = createOidcClient({ fetchFn: idp.fetchFn, now: () => t });
  await c.verifyIdToken(sign({}), opts);
  const bad = sign({}, { header: { alg: 'RS256', kid: 'random' } });
  for (let i = 0; i < 5; i++) await assert.rejects(c.verifyIdToken(bad, opts));
  assert.ok(idp.jwksFetches <= 2, `JWKS fetched ${idp.jwksFetches} times`);
  t += 61e3;
  await assert.rejects(c.verifyIdToken(bad, opts));
  assert.ok(idp.jwksFetches <= 3);
});

test('PKCE S256 matches RFC 7636 appendix B', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
