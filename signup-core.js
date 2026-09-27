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
  };
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

module.exports = { DEFAULTS, SignupError, validateSignup, signupConfigFromEnv, verificationEmail };
