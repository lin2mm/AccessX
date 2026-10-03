/**
 * Nuki Web API client — runtime-agnostic (Node server + Worker), no dependencies.
 * ====================================================================
 * https://api.nuki.io, Bearer token (an API token from Nuki Web → API, or
 * an OAuth access token). Facts this client relies on (docs.nuki.io,
 * developer.nuki.io, checked 2026-09-27):
 *
 *  - Writes are ASYNCHRONOUS: PUT/POST/DELETE return 200/204 once the request
 *    is validated, not once the lock did it. Confirm with a GET.
 *  - All times are UTC ISO strings. Lock ids are integers (safe in JS).
 *  - Keypad codes are auths of type 13: 6 digits, 1–9 only, not starting "12",
 *    unique per keypad. A date window only applies together with
 *    allowedWeekDays (127 = every day).
 *  - The `code` field of an auth has been seen as a number, a string and an
 *    array: normalise it (codeOf).
 *  - GET /smartlock/{id}/log returns at most 50 entries.
 *  - 429 and 5xx happen even at low rates: they are transient.
 */
const DEFAULT_BASE = 'https://api.nuki.io';

class NukiError extends Error {
  constructor(message, { status = 0, body = null, transient = false, auth = false } = {}) {
    super(message);
    this.name = 'NukiError';
    this.status = status;
    this.body = body;
    this.transient = transient;
    this.auth = auth;
  }
}

/** The digits of an auth's code, whatever shape Nuki sent (number, string, [number]). */
function codeOf(auth) {
  let c = auth && auth.code;
  if (Array.isArray(c)) c = c[0];
  if (c === null || c === undefined || c === '') return null;
  const s = String(c).replace(/\D/g, '');
  return s || null;
}

/** Nuki's keypad rules: 6 digits, 1–9, not starting with 12. */
const validKeypadCode = code => /^[1-9]{6}$/.test(String(code)) && !String(code).startsWith('12');

class Nuki {
  /**
   * @param opts.token      API token or OAuth access token (string, or async () => string)
   * @param opts.apiBase    override for tests (fake Nuki cloud)
   * @param opts.fetch      fetch implementation
   * @param opts.timeoutMs  per request
   */
  constructor({ token, apiBase = '', fetch: fetchFn, timeoutMs = 15000 } = {}) {
    this.base = String(apiBase || DEFAULT_BASE).replace(/\/+$/, '');
    this.tokenOf = typeof token === 'function' ? token : async () => token;
    this.fetch = fetchFn || ((...a) => globalThis.fetch(...a));
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body) {
    const token = await this.tokenOf();
    if (!token) throw new NukiError('no Nuki API token', { auth: true });
    const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new NukiError(`Nuki is not reachable (${error.name === 'TimeoutError' ? 'timed out' : 'network error'})`, { transient: true });
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (res.ok) return parsed;
    const detail = parsed && (parsed.detailMessage || parsed.message || parsed.error);
    const msg = `Nuki ${method} ${path.replace(/\/auth\/[^/]+$/, '/auth/…')} → HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`;
    throw new NukiError(msg, {
      status: res.status, body: parsed,
      auth: res.status === 401 || res.status === 403,
      transient: res.status === 429 || res.status >= 500 || (!parsed && res.status !== 404 && res.status !== 400),
    });
  }

  account() { return this.request('GET', '/account'); }
  listSmartlocks() { return this.request('GET', '/smartlock').then(r => (Array.isArray(r) ? r : [])); }
  smartlock(id) { return this.request('GET', `/smartlock/${Number(id)}`); }
  /** Unlock (Nuki: unlatch for a knob door is `action 3`; `unlock` is what the Nuki app's button does). */
  unlock(id) { return this.request('POST', `/smartlock/${Number(id)}/action/unlock`); }
  listAuths(id) { return this.request('GET', `/smartlock/${Number(id)}/auth`).then(r => (Array.isArray(r) ? r : [])); }
  createAuth(id, auth) { return this.request('PUT', `/smartlock/${Number(id)}/auth`, auth); }
  deleteAuth(id, authId) { return this.request('DELETE', `/smartlock/${Number(id)}/auth/${encodeURIComponent(String(authId))}`); }
  logs(id, limit = 50) { return this.request('GET', `/smartlock/${Number(id)}/log?limit=${Math.min(Math.max(Number(limit) || 50, 1), 50)}`).then(r => (Array.isArray(r) ? r : [])); }
}

/** Log `action` / `trigger` words (Nuki Web API guide, "Get the activity logs"). */
const LOG_ACTIONS = { 1: 'unlock', 2: 'lock', 3: 'unlatch', 4: "lock'n'go", 5: "lock'n'go with unlatch", 208: 'door ajar warning', 209: 'door status mismatch', 240: 'door opened', 241: 'door closed', 242: 'door sensor jammed', 243: 'firmware update' };
const LOG_TRIGGERS = { 0: 'system', 1: 'manual', 2: 'button', 3: 'automatic', 4: 'web', 5: 'app', 6: 'auto lock', 7: 'accessory', 255: 'keypad' };

module.exports = { Nuki, NukiError, codeOf, validKeypadCode, LOG_ACTIONS, LOG_TRIGGERS, DEFAULT_BASE };
