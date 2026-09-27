'use strict';
/**
 * Self-service signup (docs/21-SIGNUP.md): pure rules, shared by both runtimes.
 *
 * Flow: POST /api/signup {company, name, email, timeZone} stores a request and
 * emails a link; nothing else exists yet. POST /api/signup/verify {token}
 * (the link) creates the tenant and its owner, once. The response to a signup
 * is the same whether or not the address is new, capped or known: the endpoint
 * must not tell a stranger who already has an account.
 */
const { isValidTimeZone } = require('./policy-core');

const DEFAULTS = {
  linkHours: 24,        // the emailed link works this long
  keepDays: 7,          // then the request (email, name) is deleted, used or not
  perEmailPerDay: 3,    // more requests for one address are accepted silently, no email
  perIpPerDay: 5,       // more from one address (IPv6 /64) → 429
  dailyLimit: 50,       // all signups per 24 h (SIGNUP_DAILY_LIMIT); beyond → 429, platform should look
};

class SignupError extends Error {
  constructor(status, message) { super(message); this.name = 'SignupError'; this.status = status; }
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Normalised, validated request. Throws SignupError(400) with a message a person can act on. */
function validateSignup(body = {}) {
  const company = clean(body.company, 100);
  const name = clean(body.name, 100);
  const email = clean(body.email, 254).toLowerCase();
  const timeZone = clean(body.timeZone, 64) || 'UTC';
  if (!company) throw new SignupError(400, 'Company name is required.');
  if (!name) throw new SignupError(400, 'Your name is required.');
  // Deliberately plain: one @, a dot in the domain, no spaces. The emailed
  // link is the real check.
  if (!/^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) throw new SignupError(400, 'A valid work email is required.');
  if (!isValidTimeZone(timeZone)) throw new SignupError(400, 'Unknown time zone.');
  if (body.acceptTerms !== true) throw new SignupError(400, 'Please accept the terms to continue.');
  return { company, name, email, timeZone };
}

function signupConfigFromEnv(env = {}) {
  const n = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    enabled: env.SIGNUP_ENABLED === '1',
    dailyLimit: n(env.SIGNUP_DAILY_LIMIT, DEFAULTS.dailyLimit),
    termsUrl: env.SIGNUP_TERMS_URL || '',
    // R16: optional Cloudflare Turnstile (both keys, or neither).
    turnstileSiteKey: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : '',
    turnstileSecret: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SECRET_KEY : '',
    turnstileVerifyUrl: env.TURNSTILE_VERIFY_URL || TURNSTILE_VERIFY_URL,
  };
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Content-Security-Policy additions for a page that shows the Turnstile widget. */
const TURNSTILE_CSP = { script: 'https://challenges.cloudflare.com', frame: 'https://challenges.cloudflare.com' };
/** The site CSP plus Turnstile's script and frame origin (signup page only). */
function withTurnstile(csp) {
  const parts = String(csp || '').split(';').map(s => s.trim()).filter(Boolean);
  const has = name => parts.findIndex(p => p.split(/\s+/)[0] === name);
  const add = (name, src) => {
    const i = has(name);
    if (i === -1) parts.push(`${name} 'self' ${src}`);
    else if (!parts[i].split(/\s+/).includes(src)) parts[i] += ` ${src}`;
  };
  add('script-src', TURNSTILE_CSP.script);
  add('frame-src', TURNSTILE_CSP.frame);
  return parts.join('; ');
}
/**
 * Siteverify: tokens are single-use and valid 5 minutes. Fails closed.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function verifyTurnstile({ secret, token, ip, url = TURNSTILE_VERIFY_URL, fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, reason: 'missing' };
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, response: token, ...(ip && ip !== 'unknown' ? { remoteip: ip } : {}) }), signal: AbortSignal.timeout(8000) });
  } catch (error) { return { ok: false, reason: 'unavailable', detail: String(error && error.message) }; }
  const out = await res.json().catch(() => null);
  if (!res.ok || !out) return { ok: false, reason: 'unavailable', detail: `HTTP ${res.status}` };
  return out.success === true ? { ok: true } : { ok: false, reason: 'rejected', detail: (out['error-codes'] || []).join(',') };
}

function verificationEmail({ company, name, link, hours = DEFAULTS.linkHours }) {
  return {
    subject: `Confirm your AccessX account for ${company}`.slice(0, 200),
    text: [
      `Hello ${name},`,
      '',
      `Someone (hopefully you) asked to create an AccessX account for ${company}.`,
      `Open this link within ${hours} hours to create it:`,
      '',
      link,
      '',
      'You will get a sign-in key on that page. Keep it somewhere safe: it is shown once.',
      '',
      'If this was not you, ignore this email. Nothing is created until the link is opened.',
    ].join('\n'),
  };
}

module.exports = { DEFAULTS, SignupError, validateSignup, signupConfigFromEnv, verificationEmail, verifyTurnstile, withTurnstile, TURNSTILE_CSP, TURNSTILE_VERIFY_URL };
