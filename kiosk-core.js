'use strict';
// Front-desk kiosk (docs/22-KIOSK.md): pure helpers, no I/O.
//
// Two credentials, neither of which is an operator:
//   kiosk key   kx_…  shown once when an operator pairs a tablet; stored as SHA-256.
//   phone pass  p1.…  minted by a paired kiosk and shown as a QR code, valid
//                     10 minutes, signed with the kiosk key's hash (so revoking
//                     the kiosk kills every pass). Lets a visitor use their own
//                     phone while standing at reception.
const { sha256Hex } = require('./audit-core');
const policy = require('./policy-core');

const KIOSK_TOKEN_RE = /^kx_[A-Za-z0-9_-]{32,64}$/;
const PHONE_RE = /^p1\.([A-Za-z0-9_-]{1,40})\.([A-Za-z0-9_-]{1,40})\.(\d{10})\.([0-9a-f]{64})$/;
const PHONE_TTL_SEC = 600;
const LIMITS = { name: 100, company: 100, email: 200, host: 100, notice: 2000, kioskName: 60 };
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
// Expected visitors may check in from 2 hours before their visit starts.
const EARLY_MS = 2 * 3600e3;

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const tokenHash = token => sha256Hex(`kiosk|${token}`);
const noticeHash = text => (text ? sha256Hex(`visitor-notice|${text}`) : null);

async function hmacHex(keyText, message) {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, b => b.toString(16).padStart(2, '0')).join('');
}

/** secret = the kiosk row's token_sha256 (never leaves the server). */
async function mintPhonePass({ tenantId, kioskId, secret, now = Date.now() }) {
  const exp = Math.floor(now / 1000) + PHONE_TTL_SEC;
  const mac = await hmacHex(secret, `kiosk-phone|${tenantId}|${kioskId}|${exp}`);
  return { pass: `p1.${tenantId}.${kioskId}.${exp}.${mac}`, expiresAt: new Date(exp * 1000).toISOString() };
}
const parsePhonePass = pass => {
  const m = typeof pass === 'string' && pass.match(PHONE_RE);
  return m ? { tenantId: m[1], kioskId: m[2], exp: Number(m[3]), mac: m[4] } : null;
};
async function verifyPhonePass(parsed, secret, now = Date.now()) {
  if (!parsed || parsed.exp * 1000 < now || parsed.exp * 1000 > now + (PHONE_TTL_SEC + 60) * 1000) return false;
  const want = await hmacHex(secret, `kiosk-phone|${parsed.tenantId}|${parsed.kioskId}|${parsed.exp}`);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= want.charCodeAt(i) ^ parsed.mac.charCodeAt(i);
  return diff === 0;
}

/** Visitor notice (house rules, safety, privacy): empty = none required. */
function validateNotice(v) {
  if (v === undefined) return { ok: true, skip: true };
  if (v === null || v === '') return { ok: true, value: '' };
  if (typeof v !== 'string') return { ok: false, error: 'notice must be text' };
  const text = v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (text.length > LIMITS.notice) return { ok: false, error: `notice is at most ${LIMITS.notice} characters` };
  return { ok: true, value: text };
}

function validateEmail(v) {
  const email = clean(v, LIMITS.email).toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

function validateWalkin(body, { notice }) {
  const name = clean(body.name, LIMITS.name);
  if (!name) return { ok: false, error: 'Please enter your name.' };
  const company = clean(body.company, LIMITS.company) || null;
  let email = null;
  if (body.email) { email = validateEmail(body.email); if (!email) return { ok: false, error: 'That email address does not look right.' }; }
  const host = clean(body.host, LIMITS.host) || null;
  if (notice && body.acceptNotice !== true) return { ok: false, error: 'Please read and accept the visitor notice.' };
  return { ok: true, value: { name, company, email, host } };
}

/**
 * Who the walk-in visitor named as host. Deliberately narrow so the kiosk
 * cannot be used to list staff: the full name (case, spacing and accents
 * ignored) or a first name that only one person has. Anything else → null
 * and reception sorts it out.
 */
function matchHost(users, typed) {
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const q = norm(typed);
  if (q.length < 3) return null;
  const active = users.filter(u => !u.suspended && u.name);
  const exact = active.filter(u => norm(u.name) === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1 || q.includes(' ')) return null;
  const first = active.filter(u => norm(u.name).split(' ')[0] === q);
  return first.length === 1 ? first[0] : null;
}
const firstName = name => String(name || '').trim().split(/\s+/)[0] || null;

function checkinEmail({ visit, hostName, siteName, at, timeZone, tenantName }) {
  const who = visit.visitorName ? `${visit.visitorName}${visit.company ? ` (${visit.company})` : ''}` : 'Your visitor';
  return {
    subject: `${who} is at reception`.slice(0, 200),
    text: [`Hello ${hostName || ''},`.replace(/ ,$/, ','), '', `${who} signed in at the reception kiosk${siteName ? ` at ${siteName}` : ''} at ${policy.localParts(new Date(at), timeZone).label}.`, '',
      'You get this because you are their host in AccessX.', '', '—', `${tenantName || 'AccessX'} · sent by AccessX`].join('\n'),
  };
}
function walkinEmail({ walkin, hostName, siteName, at, timeZone, tenantName }) {
  const who = `${walkin.name}${walkin.company ? ` (${walkin.company})` : ''}`;
  return {
    subject: `${who} is at reception and asked for you`.slice(0, 200),
    text: [`Hello ${hostName || ''},`.replace(/ ,$/, ','), '', `${who} is at reception${siteName ? ` at ${siteName}` : ''} without an invitation (signed in at ${policy.localParts(new Date(at), timeZone).label}) and named you as their host.`, '',
      'Please go and meet them, or ask reception to let them in: AccessX → Visitors → Walk-ins → Issue code.',
      'If you are not expecting anyone, tell reception.', '', '—', `${tenantName || 'AccessX'} · sent by AccessX`].join('\n'),
  };
}

module.exports = {
  KIOSK_TOKEN_RE, PHONE_TTL_SEC, LIMITS, EARLY_MS, clean, tokenHash, noticeHash,
  mintPhonePass, parsePhonePass, verifyPhonePass, validateNotice, validateEmail, validateWalkin,
  matchHost, firstName, checkinEmail, walkinEmail,
};
