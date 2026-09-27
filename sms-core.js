/**
 * SMS for visitor codes — shared by server.js and worker.js (fetch only).
 * ====================================================================
 * Twilio Messages API: POST {base}/2010-04-01/Accounts/{AccountSid}/Messages.json
 * form-encoded To, From | MessagingServiceSid, Body; HTTP Basic auth with
 * AccountSid:AuthToken (or an API key SK…:secret). 201 = accepted.
 *
 * Like visitor emails: one attempt, never queued — the message contains a
 * door code and codes are never stored by AccessX. (Twilio keeps message
 * bodies in its own logs according to the account's settings.)
 *
 * Env: SMS_PROVIDER=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (or
 * TWILIO_API_KEY + TWILIO_API_SECRET), SMS_FROM (+E.164 number, alphanumeric
 * sender ID, or a Messaging Service SID MG…), SMS_API_BASE (tests).
 */
const E164 = /^\+[1-9]\d{6,14}$/;

/** "+44 7700 900-123" → "+447700900123"; anything else → null. */
function normalizePhone(value) {
  const s = String(value || '').replace(/[\s().-]/g, '');
  return E164.test(s) ? s : null;
}

function smsConfigFromEnv(env) {
  if (!env.SMS_PROVIDER) return null;
  const provider = String(env.SMS_PROVIDER).toLowerCase();
  if (provider !== 'twilio') throw new Error('SMS_PROVIDER must be twilio');
  const accountSid = env.TWILIO_ACCOUNT_SID || '';
  const username = env.TWILIO_API_KEY || accountSid;
  const password = env.TWILIO_API_KEY ? env.TWILIO_API_SECRET || '' : env.TWILIO_AUTH_TOKEN || '';
  const from = env.SMS_FROM || '';
  if (!accountSid || !password || !from) throw new Error('SMS needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (or TWILIO_API_KEY/SECRET) and SMS_FROM');
  return { provider, accountSid, username, password, from, apiBase: env.SMS_API_BASE || 'https://api.twilio.com' };
}

function smsRequest(cfg, to, body) {
  const form = new URLSearchParams({ To: to, Body: body });
  if (/^MG[0-9a-f]{32}$/i.test(cfg.from)) form.set('MessagingServiceSid', cfg.from);
  else form.set('From', cfg.from);
  return {
    url: `${cfg.apiBase}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`,
    headers: { authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  };
}

function createSms({ config = null, fetchFn } = {}) {
  const fetch = fetchFn || ((...a) => globalThis.fetch(...a));
  return {
    available: Boolean(config),
    /** Never throws: 'delivered' | 'failed: …' | 'skipped: …'. */
    async send(to, body) {
      if (!config) return 'skipped: SMS is not configured on this server';
      const number = normalizePhone(to);
      if (!number) return 'failed: not an international phone number';
      const req = smsRequest(config, number, String(body).slice(0, 1600));
      try {
        const res = await fetch(req.url, {
          method: 'POST', headers: req.headers, body: req.body, redirect: 'manual',
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined,
        });
        return res.status >= 200 && res.status < 300 ? 'delivered' : `failed: HTTP ${res.status}`;
      } catch (error) {
        return `failed: ${String(error.message || error).slice(0, 80)}`;
      }
    },
  };
}

module.exports = { createSms, smsConfigFromEnv, smsRequest, normalizePhone };
