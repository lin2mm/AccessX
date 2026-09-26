/**
 * Session cookie helpers (no Node/Web APIs — shared by server and worker).
 * HttpOnly: page JavaScript (and any XSS) cannot read the session.
 * __Host- prefix (on HTTPS): the browser only accepts it with Secure,
 * Path=/ and no Domain, so a sibling subdomain cannot plant or read it.
 */
const NAMES = ['__Host-ax_session', 'ax_session'];

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionIdFrom(header) {
  const c = parseCookies(header);
  for (const n of NAMES) if (c[n]) return c[n];
  return null;
}

/**
 * sameSite 'Lax' (default) blocks cross-site POSTs from carrying the cookie.
 * 'None' is only for embedding the app in another site's iframe; it forces
 * Secure + Partitioned (CHIPS), and CSRF tokens remain mandatory.
 */
function sessionCookie(value, { secure = false, sameSite = 'Lax', maxAgeSec = 0 } = {}) {
  const none = String(sameSite).toLowerCase() === 'none';
  const isSecure = secure || none;
  const name = isSecure ? NAMES[0] : NAMES[1];
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${none ? 'None' : 'Lax'}`, `Max-Age=${maxAgeSec}`];
  if (isSecure) parts.push('Secure');
  if (none) parts.push('Partitioned');
  return parts.join('; ');
}

const clearSessionCookies = opts => [sessionCookie('', { ...opts, maxAgeSec: 0 }), sessionCookie('', { ...opts, secure: false, sameSite: 'Lax', maxAgeSec: 0 })];

module.exports = { parseCookies, sessionIdFrom, sessionCookie, clearSessionCookies };
