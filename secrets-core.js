/**
 * Per-tenant secrets at rest (SSO client secrets, later vendor accounts).
 * AES-256-GCM with a deployment key (SECRETS_KEY, 32 bytes base64). The
 * tenant id and purpose are bound in as additional authenticated data, so
 * a ciphertext copied into another tenant's settings will not decrypt.
 * WebCrypto only — works in Node 22 and Workers.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function importKey(base64Key) {
  if (!base64Key) { const e = new Error('SECRETS_KEY is not configured; cannot store secrets'); e.status = 400; throw e; }
  const raw = unb64(base64Key);
  if (raw.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded');
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptSecret(base64Key, plaintext, { tenantId, purpose }) {
  const key = await importKey(base64Key);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`${tenantId}|${purpose}`) }, key, enc.encode(String(plaintext)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

async function decryptSecret(base64Key, sealed, { tenantId, purpose }) {
  const [v, iv, ct] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('unrecognised secret format');
  const key = await importKey(base64Key);
  const pt = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(`${tenantId}|${purpose}`) }, key, unb64(ct));
  return dec.decode(pt);
}

module.exports = { encryptSecret, decryptSecret };
