/**
 * OpenID Connect (authorization code + PKCE) for operator sign-in.
 * WebCrypto + fetch only — shared by server and worker.
 *
 * Verification rules (all must pass):
 *  - RS256 signature against the issuer's JWKS (alg "none"/HS* refused)
 *  - iss === configured issuer, aud contains our client id
 *  - exp in the future (60 s leeway), nonce === the one we sent
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const randomB64url = (n = 32) => b64url(globalThis.crypto.getRandomValues(new Uint8Array(n)));

class OidcError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

async function pkceChallenge(verifier) {
  return b64url(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(verifier)));
}

function createOidcClient({ fetchFn = (...a) => globalThis.fetch(...a), now = () => Date.now(), cacheMs = 3600e3 } = {}) {
  const discoveryCache = new Map();
  const jwksCache = new Map();

  async function getJson(url, init) {
    const res = await fetchFn(url, init);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new OidcError('bad_response', `${url} did not return JSON (HTTP ${res.status})`); }
    if (!res.ok) throw new OidcError('provider_error', `${url}: HTTP ${res.status} ${body.error || ''} ${body.error_description || ''}`.trim());
    return body;
  }

  async function discover(issuer) {
    const hit = discoveryCache.get(issuer);
    if (hit && hit.at + cacheMs > now()) return hit.doc;
    const doc = await getJson(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
    // Mix-up defence: the document must claim exactly the issuer we asked for.
    if (doc.issuer !== issuer) throw new OidcError('issuer_mismatch', `discovery says issuer "${doc.issuer}", expected "${issuer}"`);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!doc[k]) throw new OidcError('bad_discovery', `discovery lacks ${k}`);
    discoveryCache.set(issuer, { at: now(), doc });
    return doc;
  }

  async function keyFor(jwksUri, kid) {
    const lookup = async force => {
      let entry = jwksCache.get(jwksUri);
      if (force || !entry || entry.at + cacheMs < now()) {
        // Refetch at most once a minute (key rotation without letting
        // attackers force a fetch per request with random kids).
        if (entry && force && entry.at + 60e3 > now()) return entry.keys.find(k => k.kid === kid);
        entry = { at: now(), keys: (await getJson(jwksUri)).keys || [] };
        jwksCache.set(jwksUri, entry);
      }
      return entry.keys.find(k => k.kid === kid);
    };
    return (await lookup(false)) || (await lookup(true));
  }

  async function verifyIdToken(idToken, { issuer, clientId, nonce }) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new OidcError('bad_token', 'malformed id_token');
    let header;
    let claims;
    try {
      header = JSON.parse(dec.decode(fromB64url(parts[0])));
      claims = JSON.parse(dec.decode(fromB64url(parts[1])));
    } catch { throw new OidcError('bad_token', 'undecodable id_token'); }
    if (header.alg !== 'RS256') throw new OidcError('bad_token', `unsupported alg ${header.alg}`);
    const doc = await discover(issuer);
    const jwk = await keyFor(doc.jwks_uri, header.kid);
    if (!jwk) throw new OidcError('bad_token', 'signing key not found in JWKS');
    const key = await globalThis.crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) throw new OidcError('bad_token', 'bad signature');
    const t = now() / 1000;
    if (claims.iss !== issuer) throw new OidcError('bad_token', 'wrong issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) throw new OidcError('bad_token', 'wrong audience');
    if (aud.length > 1 && claims.azp && claims.azp !== clientId) throw new OidcError('bad_token', 'wrong authorized party');
    if (typeof claims.exp !== 'number' || claims.exp + 60 < t) throw new OidcError('expired', 'id_token expired');
    if (claims.iat && claims.iat - 300 > t) throw new OidcError('bad_token', 'id_token issued in the future');
    if (!nonce || claims.nonce !== nonce) throw new OidcError('bad_token', 'nonce mismatch');
    if (!claims.sub) throw new OidcError('bad_token', 'no subject');
    return claims;
  }

  async function authorizationUrl({ config, redirectUri, state, nonce, codeVerifier, loginHint, origin }) {
    const doc = await discover(config.issuer);
    // Relative endpoints are only produced by the bundled mock IdP.
    const url = new URL(doc.authorization_endpoint, origin);
    const q = url.searchParams;
    q.set('response_type', 'code');
    q.set('client_id', config.clientId);
    q.set('redirect_uri', redirectUri);
    q.set('scope', 'openid email profile');
    q.set('state', state);
    q.set('nonce', nonce);
    q.set('code_challenge', await pkceChallenge(codeVerifier));
    q.set('code_challenge_method', 'S256');
    if (loginHint) q.set('login_hint', loginHint);
    return url.toString();
  }

  async function exchangeCode({ config, clientSecret, code, redirectUri, codeVerifier }) {
    const doc = await discover(config.issuer);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: config.clientId, code_verifier: codeVerifier });
    if (clientSecret) form.set('client_secret', clientSecret);
    const body = await getJson(doc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() });
    if (!body.id_token) throw new OidcError('provider_error', 'token response has no id_token');
    return body.id_token;
  }

  return { discover, verifyIdToken, authorizationUrl, exchangeCode };
}

module.exports = { createOidcClient, OidcError, randomB64url, pkceChallenge, b64url, fromB64url };
