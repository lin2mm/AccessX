/**
 * Mock OpenID Connect provider — FOR TESTS AND DEMOS ONLY.
 * Mounted by server.js at /mock-idp when MOCK_IDP=1. Implements discovery,
 * JWKS, authorization code + PKCE (S256) and RS256 id_tokens, so the real
 * OIDC client code path is exercised end to end.
 *
 * The issuer is derived from the Host the request arrived on, so the
 * server can reach it at http://127.0.0.1:<port>/mock-idp. The
 * authorization endpoint is advertised as a *relative* path so the
 * browser stays on the app's public origin (e.g. a preview proxy).
 */
const crypto = require('node:crypto');
const express = require('express');

const DEFAULT_USERS = [
  { sub: 'mock|alice', email: 'alice@riverside.example', email_verified: true, name: 'Alice Chen (Riverside IT)' },
  { sub: 'mock|bob', email: 'bob@riverside.example', email_verified: true, name: 'Bob Smith (not invited)' },
  // nOAuth-style attack: claims someone else's address without verifying it.
  { sub: 'mock|mallory', email: 'alice@riverside.example', email_verified: false, name: 'Mallory (unverified email)' },
];

const b64url = buf => Buffer.from(buf).toString('base64url');

function createMockIdp({ basePath = '/mock-idp', users = DEFAULT_USERS, clientSecret = null } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `mock-${crypto.randomBytes(4).toString('hex')}`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const router = express.Router();
  const issuerOf = req => `${req.protocol}://${req.get('host')}${basePath}`;

  router.get('/.well-known/openid-configuration', (req, res) => {
    const iss = issuerOf(req);
    res.json({
      issuer: iss,
      authorization_endpoint: `${basePath}/authorize`, // relative on purpose (see header)
      token_endpoint: `${iss}/token`,
      jwks_uri: `${iss}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    });
  });
  router.get('/jwks', (req, res) => res.json({ keys: [jwk] }));

  router.get('/authorize', (req, res) => {
    const q = req.query;
    if (q.response_type !== 'code' || !q.client_id || !q.redirect_uri || q.code_challenge_method !== 'S256' || !q.code_challenge) {
      return res.status(400).send('invalid authorization request');
    }
    const user = users.find(u => u.sub === q.user);
    if (!user) {
      const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const link = u => {
        const p = new URLSearchParams({ ...q, user: u.sub });
        return `<li><a href="${esc(`${basePath}/authorize?${p}`)}">${esc(u.name)}</a> <small>${esc(u.email)}${u.email_verified ? '' : ' — UNVERIFIED'}</small></li>`;
      };
      return res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Mock identity provider</title>
<body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<h2>Mock identity provider</h2><p><b>Demo only.</b> Pick who you are:</p><ul>${users.map(link).join('')}</ul></body>`);
    }
    const code = crypto.randomBytes(24).toString('base64url');
    codes.set(code, { user, clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge, nonce: q.nonce, exp: Date.now() + 60e3 });
    const back = new URL(q.redirect_uri);
    back.searchParams.set('code', code);
    if (q.state) back.searchParams.set('state', q.state);
    return res.redirect(302, back.toString());
  });

  router.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const b = req.body || {};
    const entry = codes.get(b.code);
    codes.delete(b.code); // single use
    const fail = (error, status = 400) => res.status(status).json({ error });
    if (!entry || entry.exp < Date.now()) return fail('invalid_grant');
    if (b.grant_type !== 'authorization_code' || b.client_id !== entry.clientId || b.redirect_uri !== entry.redirectUri) return fail('invalid_grant');
    if (clientSecret && b.client_secret !== clientSecret) return fail('invalid_client', 401);
    const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
    if (challenge !== entry.challenge) return fail('invalid_grant');
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const payload = b64url(JSON.stringify({
      iss: issuerOf(req), sub: entry.user.sub, aud: entry.clientId, iat: now, exp: now + 300, nonce: entry.nonce,
      email: entry.user.email, email_verified: entry.user.email_verified, name: entry.user.name,
    }));
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    return res.json({ token_type: 'Bearer', access_token: crypto.randomBytes(16).toString('hex'), expires_in: 300, id_token: `${header}.${payload}.${sig}` });
  });

  return { router, users, privateKey, kid };
}

module.exports = { createMockIdp, DEFAULT_USERS };
