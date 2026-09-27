'use strict';
/**
 * Stripe billing (docs/BILLING.md): per door per month billed as door-days,
 * SMS segments at cost plus. Off unless BILLING_ENABLED=1 and the Stripe
 * settings are present. Plain fetch (no SDK), WebCrypto for signatures, so
 * the same code runs on Node and Workers.
 *
 * Never tied to door access: non-payment only stops *additions* (people,
 * visitors, codes, rules). Removing access always works.
 */

const API_VERSION = '2025-03-31.basil';
const RESTRICT_AFTER_DAYS = 15;
const MAX_BACKFILL_DAYS = 30; // Stripe accepts meter events up to 35 days old
const enc = new TextEncoder();

class BillingError extends Error {
  constructor(status, message, extra = {}) { super(message); this.name = 'BillingError'; this.status = status; this.extra = extra; }
}

function billingConfigFromEnv(env = {}) {
  const c = {
    enabled: env.BILLING_ENABLED === '1',
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    priceDoorDays: env.STRIPE_PRICE_DOOR_DAYS || '',
    priceSms: env.STRIPE_PRICE_SMS || '',
    meterDoorDays: env.STRIPE_METER_DOOR_DAYS || 'accessx_door_days',
    meterSms: env.STRIPE_METER_SMS || 'accessx_sms_segments',
    apiBase: (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, ''),
    apiVersion: env.STRIPE_API_VERSION || API_VERSION,
    automaticTax: env.STRIPE_AUTOMATIC_TAX === '1',
  };
  c.problems = [];
  if (c.enabled) {
    if (!/^(sk|rk)_(test|live)_/.test(c.secretKey)) c.problems.push('STRIPE_SECRET_KEY');
    if (!/^whsec_/.test(c.webhookSecret)) c.problems.push('STRIPE_WEBHOOK_SECRET');
    if (!/^price_/.test(c.priceDoorDays)) c.problems.push('STRIPE_PRICE_DOOR_DAYS');
    if (c.priceSms && !/^price_/.test(c.priceSms)) c.problems.push('STRIPE_PRICE_SMS');
  }
  c.active = c.enabled && !c.problems.length;
  c.testMode = /^(sk|rk)_test_/.test(c.secretKey);
  return c;
}

/** Stripe's form encoding: nested objects and arrays as a[b][0][c]=v. */
function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x !== null && typeof x === 'object' ? formEncode(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

function createStripe(config, { fetchFn = (...a) => globalThis.fetch(...a) } = {}) {
  async function call(method, path, params, { idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${config.secretKey}`, 'stripe-version': config.apiVersion };
    let body;
    if (method !== 'GET') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = formEncode(params).toString();
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    }
    const qs = method === 'GET' && params ? `?${formEncode(params)}` : '';
    let res;
    try {
      res = await fetchFn(`${config.apiBase}${path}${qs}`, { method, headers, body, redirect: 'manual', signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined });
    } catch (error) {
      throw new BillingError(502, `Stripe unreachable: ${error.message}`);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      const e = (json && json.error) || {};
      throw new BillingError(res.status >= 500 ? 502 : 400, `Stripe: ${e.message || `HTTP ${res.status}`}`, { stripeCode: e.code, stripeStatus: res.status });
    }
    return json;
  }
  return {
    checkout: (p, key) => call('POST', '/v1/checkout/sessions', p, { idempotencyKey: key }),
    portal: p => call('POST', '/v1/billing_portal/sessions', p),
    meterEvent: (p) => call('POST', '/v1/billing/meter_events', p, { idempotencyKey: p.identifier }),
  };
}

const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Stripe-Signature: "t=<unix>,v1=<hex>[,v1=...]"; signed payload "<t>.<raw body>",
 * HMAC-SHA256 with the endpoint secret. Returns the parsed event or throws.
 */
async function verifyWebhook(rawBody, header, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  const parts = String(header || '').split(',').map(p => p.trim().split('='));
  const t = Number((parts.find(([k]) => k === 't') || [])[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => String(v || '').toLowerCase());
  if (!Number.isSafeInteger(t) || !sigs.length) throw new BillingError(400, 'bad signature header');
  if (Math.abs(now / 1000 - t) > toleranceSec) throw new BillingError(400, 'signature timestamp outside tolerance');
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`)));
  if (!sigs.some(s => constantTimeEqual(s, expected))) throw new BillingError(400, 'signature mismatch');
  let event;
  try { event = JSON.parse(rawBody); } catch { throw new BillingError(400, 'invalid JSON'); }
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') throw new BillingError(400, 'not a Stripe event');
  return event;
}

/** Signature for tests and local tools. */
async function signWebhook(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `t=${t},v1=${hex(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`)))}`;
}

const PAST_DUE = new Set(['past_due', 'unpaid']);
const ENDED = new Set(['canceled', 'incomplete_expired']);

/**
 * What the tenant may do. No account = pilot/trial: nothing restricted.
 * restricted: additions blocked (people, visitors, codes, rules); removals never.
 */
function standing(account, now = Date.now()) {
  if (!account) return { status: 'none', restricted: false };
  const since = account.pastDueSince ? Date.parse(account.pastDueSince) : null;
  const pastDueDays = PAST_DUE.has(account.status) && since ? Math.floor((now - since) / 864e5) : 0;
  const restricted = ENDED.has(account.status) || (PAST_DUE.has(account.status) && pastDueDays >= RESTRICT_AFTER_DAYS);
  return { status: account.status, pastDueDays, restricted, restrictsInDays: PAST_DUE.has(account.status) && !restricted ? RESTRICT_AFTER_DAYS - pastDueDays : null };
}

/** New state from a subscription status (null past_due_since when paid again). */
function nextAccountState(prev, status, at) {
  const pastDue = PAST_DUE.has(status);
  return { status, pastDueSince: pastDue ? ((prev && prev.pastDueSince) || at) : null };
}

/** Requests that add access or cost money; blocked while restricted. */
const ADDITIONS = [
  ['POST', /^\/api\/(users|assignments|doorGroups|userGroups|schedules|passcode|visits|visit-invites|onboarding\/office)$/],
  ['POST', /^\/scim\/v2\/(Users|Groups)$/],
];
const isAddition = (method, path) => ADDITIONS.some(([m, re]) => m === method && re.test(path));

module.exports = {
  API_VERSION, RESTRICT_AFTER_DAYS, MAX_BACKFILL_DAYS, BillingError, billingConfigFromEnv, formEncode, createStripe,
  verifyWebhook, signWebhook, standing, nextAccountState, isAddition,
};
