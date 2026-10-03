/**
 * TXT lookups over DNS-over-HTTPS (JSON API) — the same code in Node and
 * Workers, no `node:dns`. Used to prove a tenant controls an email domain
 * before that domain routes logins or lets a directory adopt people.
 *
 * `overrides` exist for tests and the local demo only (see server.js).
 */
const DOH_DEFAULT = 'https://cloudflare-dns.com/dns-query';

/** DoH returns TXT data quoted, long records split: "\"abc\" \"def\"" → "abcdef". */
function parseTxtData(data) {
  const s = String(data || '');
  const parts = [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
  return parts.length ? parts.join('') : s;
}

function createDnsTxtResolver({ fetchFn, dohUrl = DOH_DEFAULT, timeoutMs = 4000 } = {}) {
  const fetch = fetchFn || ((...a) => globalThis.fetch(...a));
  const overrides = new Map();
  async function txt(name) {
    const key = String(name).toLowerCase().replace(/\.$/, '');
    if (overrides.has(key)) return overrides.get(key).slice();
    const url = `${dohUrl}?name=${encodeURIComponent(key)}&type=TXT`;
    const res = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) throw new Error(`DNS lookup failed (HTTP ${res.status})`);
    const body = await res.json();
    if (body.Status === 3) return []; // NXDOMAIN
    if (body.Status !== 0) throw new Error(`DNS lookup failed (status ${body.Status})`);
    return (body.Answer || []).filter(a => a.type === 16).map(a => parseTxtData(a.data));
  }
  return {
    txt,
    /** Tests/demo only. */
    set(name, values) { overrides.set(String(name).toLowerCase(), [].concat(values)); },
    clear() { overrides.clear(); },
  };
}

module.exports = { createDnsTxtResolver, parseTxtData };
