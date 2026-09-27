/**
 * Audit anchors — signed statements "tenant T's audit chain had hash H at
 * seq N at time A". WebCrypto Ed25519: works in Node 22 and Workers.
 *
 * Why sign at all, if we hold the key? The customer (or their auditor)
 * keeps a copy of every anchor outside AccessX. Later:
 *  - if WE rewrote history, their anchor no longer matches the chain;
 *  - the signature stops anyone from forging an anchor to claim we did.
 *
 * Key: AUDIT_SIGNING_KEY = Ed25519 private key as JWK JSON
 * ({"kty":"OKP","crv":"Ed25519","d":…,"x":…}); `npm run audit:keygen`.
 */
const { sha256Hex } = require('./audit-core');

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));

/** The exact bytes that get signed. Plain lines: no JSON canonicalisation pitfalls. */
function anchorPayload({ tenantId, seq, hash, at }) {
  return `accessx-anchor-v1\n${tenantId}\n${Number(seq)}\n${hash}\n${at}`;
}

const keyIdFor = x => sha256Hex(`ed25519:${x}`).slice(0, 16);

async function loadSigningKey(jwkJson) {
  if (!jwkJson) return null;
  let jwk;
  try { jwk = typeof jwkJson === 'string' ? JSON.parse(jwkJson) : jwkJson; } catch { throw new Error('AUDIT_SIGNING_KEY must be an Ed25519 JWK (JSON)'); }
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d || !jwk.x) throw new Error('AUDIT_SIGNING_KEY must be an Ed25519 private JWK with d and x');
  const key = await globalThis.crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x }, { name: 'Ed25519' }, false, ['sign']);
  const keyId = keyIdFor(jwk.x);
  return {
    keyId,
    publicKey: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: keyId, alg: 'EdDSA', use: 'sig' },
    async sign(payload) {
      return b64url(await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(payload)));
    },
  };
}

async function verifyAnchor(anchor, { tenantId, publicKey }) {
  if (!anchor.signature || !publicKey) return false;
  if (anchor.keyId && publicKey.kid && anchor.keyId !== publicKey.kid) return false;
  const key = await globalThis.crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: publicKey.x }, { name: 'Ed25519' }, false, ['verify']);
  return globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, unb64url(anchor.signature),
    new TextEncoder().encode(anchorPayload({ tenantId, seq: anchor.seq, hash: anchor.hash, at: anchor.createdAt })));
}

async function generateSigningKey() {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
  return { private: { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x }, keyId: keyIdFor(jwk.x) };
}

module.exports = { anchorPayload, loadSigningKey, verifyAnchor, generateSigningKey, keyIdFor };
