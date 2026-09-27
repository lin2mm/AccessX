/**
 * Per-tenant secrets at rest (TTLock tokens, SSO client secrets, alert
 * webhooks, approved passcodes). AES-256-GCM with a deployment key. The
 * tenant id and purpose are bound in as additional authenticated data, so a
 * ciphertext copied into another tenant (or another purpose) will not decrypt.
 * WebCrypto only — works in Node 22 and Workers.
 *
 * Key rotation: SECRETS_KEY may be a comma-separated keyring "new,old,…".
 * The first key encrypts; every key decrypts. Ciphertexts name their key:
 *   v2.<kid>.<iv>.<ct>   kid = first 8 bytes of SHA-256(key), hex
 *   v1.<iv>.<ct>         legacy (single key): each key is tried in turn
 * Rotate: prepend a new key, deploy, run the re-seal (POST
 * /api/platform/secrets/reseal), check GET /api/platform/secrets shows nothing
 * left on the old key, then drop it.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

const cache = new Map(); // keyring string → Promise<[{ kid, key }]>

function keyring(secretsKey) {
  const spec = String(secretsKey || '');
  if (!spec.trim()) { const e = new Error('SECRETS_KEY is not configured; cannot store secrets'); e.status = 400; throw e; }
  if (!cache.has(spec)) {
    cache.set(spec, Promise.all(spec.split(',').map(s => s.trim()).filter(Boolean).map(async k => {
      let raw;
      try { raw = unb64(k); } catch { raw = new Uint8Array(0); }
      if (raw.length !== 32) throw new Error('each SECRETS_KEY entry must be 32 bytes, base64-encoded');
      const kid = hex(await globalThis.crypto.subtle.digest('SHA-256', raw)).slice(0, 16);
      return { kid, key: await globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) };
    })).catch(error => { cache.delete(spec); throw error; }));
  }
  return cache.get(spec);
}

const aad = ({ tenantId, purpose }) => enc.encode(`${tenantId}|${purpose}`);

async function encryptSecret(secretsKey, plaintext, ctx) {
  const [{ kid, key }] = await keyring(secretsKey);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(ctx) }, key, enc.encode(String(plaintext)));
  return `v2.${kid}.${b64(iv)}.${b64(ct)}`;
}

async function decryptSecret(secretsKey, sealed, ctx) {
  const parts = String(sealed || '').split('.');
  const ring = await keyring(secretsKey);
  const open = async (key, iv, ct) => dec.decode(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad(ctx) }, key, unb64(ct)));
  if (parts[0] === 'v2' && parts.length === 4) {
    const k = ring.find(r => r.kid === parts[1]);
    if (!k) throw new Error(`secret was sealed with key ${parts[1]}, which is not in SECRETS_KEY`);
    return open(k.key, parts[2], parts[3]);
  }
  if (parts[0] === 'v1' && parts.length === 3) {
    for (const k of ring) { try { return await open(k.key, parts[1], parts[2]); } catch { /* next key */ } }
    throw new Error('secret does not decrypt with any SECRETS_KEY entry');
  }
  throw new Error('unrecognised secret format');
}

/** Key id a ciphertext was sealed with ('v1' for legacy values). */
const sealedKeyId = sealed => { const p = String(sealed || '').split('.'); return p[0] === 'v2' ? p[1] : p[0] === 'v1' ? 'v1' : null; };
const primaryKeyId = async secretsKey => (await keyring(secretsKey))[0].kid;
const keyIds = async secretsKey => (await keyring(secretsKey)).map(k => k.kid);

module.exports = { encryptSecret, decryptSecret, sealedKeyId, primaryKeyId, keyIds };
