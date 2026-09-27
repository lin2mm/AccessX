/**
 * Alerts: push the few events a human must act on to the customer's chat.
 *
 *   approval_requested  a four-eyes request waits for a second person
 *   removal_overdue     a revoked code is still on an offline lock past the SLA
 *   revoke_failed       the cloud could not revoke a code (it still works)
 *   break_glass         someone signed in with a token while SSO is enforced
 *   vendor_needs_reconnect  TTLock refused the account's tokens: revocations
 *                       stop until an owner reconnects
 *
 * Formats: Slack incoming webhook ({text}), Microsoft Teams Workflows
 * ("Post to a channel when a webhook request is received": an Adaptive Card
 * attachment — the old Office 365 connector format is retired), or plain JSON
 * for a SIEM / ticketing system.
 *
 * The webhook URL is a bearer secret (Slack's path, Teams' `sig=`), so it is
 * sealed with SECRETS_KEY and never returned — only its host.
 * Email (optional, per deployment): EMAIL_PROVIDER=resend|postmark with
 * EMAIL_API_KEY and EMAIL_FROM; each tenant lists up to 10 recipients.
 * HTTP APIs, not SMTP — Workers cannot open SMTP connections.
 *
 * Delivery never blocks or fails the change that caused it (4 s timeout).
 * A transient failure (network, timeout, 5xx, 408, 429) goes to the
 * `alert_outbox` and is retried by the scheduled maintenance with backoff
 * (5 min doubling, max 6 h, 8 attempts); an alert that is finally given up is
 * audited (`alerts.dropped`). Other 4xx are configuration errors: not retried.
 * The outbox stores the message, never the URL or the recipients: a retry
 * goes to the channel as configured *now*. The audit log remains the record.
 */
const { encryptSecret, decryptSecret } = require('./secrets-core');
const { checkWebhookUrl } = require('./audit-ops');

const EVENTS = ['approval_requested', 'removal_overdue', 'revoke_failed', 'break_glass', 'vendor_needs_reconnect', 'visitor_arrived'];
// Informational, and they name people: channels get these only when an owner turns them on.
const OPT_IN_EVENTS = ['visitor_arrived'];
const DEFAULT_EVENTS = EVENTS.filter(e => !OPT_IN_EVENTS.includes(e));
const FORMATS = ['slack', 'teams', 'json'];
const EMAIL_PROVIDERS = {
  resend: { base: 'https://api.resend.com', path: '/emails' },
  postmark: { base: 'https://api.postmarkapp.com', path: '/email' },
};
const MAX_EMAILS = 10;
const RETRY = { maxAttempts: 8, baseMs: 5 * 60e3, capMs: 6 * 3600e3 };
const OUTBOX_CAP = 500; // per tenant: a dead channel must not grow the table without bound
const EMAIL_RE = /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[^\s@<>(),;:"\[\]]+$/;
const DEFAULT_SLA_HOURS = 48;
const PURPOSE = 'alerts-webhook';

class AlertsError extends Error {
  constructor(status, message) { super(message); this.name = 'AlertsError'; this.status = status; }
}

/** Message body for each chat format. facts: [[label, value], …] */
function formatMessage(format, { id, event, title, text, facts = [], link, tenant, at }) {
  if (format === 'slack') {
    const lines = [`*${title}*`, text, ...facts.map(([k, v]) => `• ${k}: ${v}`)];
    if (link) lines.push(`<${link}|Open AccessX>`);
    return { text: lines.filter(Boolean).join('\n') };
  }
  if (format === 'teams') {
    const content = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
      body: [
        { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
        ...(text ? [{ type: 'TextBlock', text, wrap: true }] : []),
        ...(facts.length ? [{ type: 'FactSet', facts: facts.map(([k, v]) => ({ title: String(k), value: String(v) })) }] : []),
      ],
      ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open AccessX', url: link }] } : {}),
    };
    return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content }] };
  }
  // `id` stays the same across retries: a SIEM can drop duplicates.
  return { id: id || null, type: `accessx.alert.${event}`, tenant, at, title, text, facts: Object.fromEntries(facts), link: link || null };
}

/** Plain-text email (no HTML: nothing to escape, nothing to inject). */
function formatEmail({ title, text, facts = [], link, tenant }) {
  const oneLine = v => String(v).replace(/[\r\n]+/g, ' ').trim();
  const body = [title, '', text || '', ...(facts.length ? ['', ...facts.map(([k, v]) => `${k}: ${v}`)] : []), ...(link ? ['', `Open AccessX: ${link}`] : []),
    '', '—', `AccessX alert for ${tenant && tenant.name ? tenant.name : 'your account'}. Recipients are set by an account owner (Settings → Alerts).`];
  return { subject: oneLine(`[AccessX] ${title}`).slice(0, 200), text: body.join('\n') };
}

/** HTTP request for the email provider's send API. */
function emailRequest({ provider, apiKey, from, apiBase }, to, { subject, text }, id) {
  const p = EMAIL_PROVIDERS[provider];
  const url = `${apiBase || p.base}${p.path}`;
  if (provider === 'resend') {
    // Idempotency-Key: a retry after a lost response does not send twice (24 h window).
    return { url, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': `accessx-${id}` }, body: { from, to, subject, text } };
  }
  return { url, headers: { 'x-postmark-server-token': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: { From: from, To: to.join(','), Subject: subject, TextBody: text, MessageStream: 'outbound', Metadata: { alertId: id } } };
}

/** 5xx, 408, 429 and network errors are worth retrying; other 4xx are configuration errors. */
const retryableHttp = status => status >= 500 || status === 408 || status === 429;

function createAlerts({ store, secretsKey = '', fetchFn, allowHttp = false, publicUrl = '', email = {}, log = () => {}, now = () => Date.now(), uid = () => globalThis.crypto.randomUUID() }) {
  const fetch = fetchFn || ((...a) => globalThis.fetch(...a));
  const read = async tenantId => (((await store.tenantSettings(tenantId)) || {}).alerts) || {};
  const emailCfg = email && email.provider ? email : null;
  if (emailCfg && !(EMAIL_PROVIDERS[emailCfg.provider] && emailCfg.apiKey && emailCfg.from)) {
    throw new Error(`email alerts: EMAIL_PROVIDER must be one of ${Object.keys(EMAIL_PROVIDERS).join(', ')}, with EMAIL_API_KEY and EMAIL_FROM`);
  }
  const iso = ms => new Date(ms).toISOString();

  async function settings(tenantId) {
    const a = await read(tenantId);
    const outbox = await store.sql.first('SELECT COUNT(*) AS n, MIN(next_at) AS next FROM alert_outbox WHERE tenant_id = ?', [tenantId]);
    return {
      configured: Boolean(a.sealedUrl || (emailCfg && (a.emails || []).length)), format: a.format || null, host: a.host || null,
      emails: a.emails || [], emailAvailable: Boolean(emailCfg), emailProvider: emailCfg ? emailCfg.provider : null,
      events: a.events || DEFAULT_EVENTS, slaHours: a.slaHours || DEFAULT_SLA_HOURS,
      lastDelivery: a.lastDelivery || null, lastEmailDelivery: a.lastEmailDelivery || null,
      retrying: { count: outbox.n || 0, nextAt: outbox.next || null },
      availableEvents: EVENTS, formats: FORMATS, secretsKeyConfigured: Boolean(secretsKey),
    };
  }

  const slaHours = async tenantId => (await read(tenantId)).slaHours || DEFAULT_SLA_HOURS;

  async function save(tenantId, body, actor) {
    const all = (await store.tenantSettings(tenantId)) || {};
    const cur = all.alerts || {};
    const next = { ...cur };
    if ('slaHours' in body) {
      const h = Number(body.slaHours);
      if (!Number.isInteger(h) || h < 1 || h > 720) throw new AlertsError(400, 'slaHours must be a whole number of hours between 1 and 720');
      next.slaHours = h;
    }
    if ('events' in body) {
      if (!Array.isArray(body.events) || body.events.some(e => !EVENTS.includes(e))) throw new AlertsError(400, `events must be a list drawn from ${EVENTS.join(', ')}`);
      next.events = [...new Set(body.events)];
    }
    if ('format' in body) {
      if (!FORMATS.includes(body.format)) throw new AlertsError(400, `format must be one of ${FORMATS.join(', ')}`);
      next.format = body.format;
    }
    if ('emails' in body) {
      const list = body.emails === null ? [] : body.emails;
      if (!Array.isArray(list) || list.some(e => typeof e !== 'string' || e.length > 254 || !EMAIL_RE.test(e.trim()))) throw new AlertsError(400, 'emails must be a list of email addresses');
      const clean = [...new Set(list.map(e => e.trim().toLowerCase()))];
      if (clean.length > MAX_EMAILS) throw new AlertsError(400, `at most ${MAX_EMAILS} alert recipients`);
      if (clean.length && !emailCfg) throw new AlertsError(400, 'email alerts are not configured on this server (EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM)');
      if (clean.length) next.emails = clean; else { delete next.emails; delete next.lastEmailDelivery; }
    }
    if ('webhookUrl' in body) {
      if (!body.webhookUrl) { delete next.sealedUrl; delete next.host; delete next.lastDelivery; } else {
        if (!secretsKey) throw new AlertsError(400, 'SECRETS_KEY is not configured on the server; a webhook URL is a secret and is stored encrypted');
        const url = checkWebhookUrl(body.webhookUrl, { allowHttp, field: 'webhookUrl' });
        next.sealedUrl = await encryptSecret(secretsKey, url, { tenantId, purpose: PURPOSE });
        next.host = new URL(url).host;
        delete next.lastDelivery;
        if (!next.format) next.format = /(^|\.)hooks\.slack\.com$/.test(next.host) ? 'slack' : /logic\.azure\.com|powerplatform|environment\.api\.powerplatform/.test(next.host) ? 'teams' : 'json';
      }
    }
    await store.tenant(tenantId).unit()
      .raw('UPDATE tenants SET settings = ? WHERE id = ?', [JSON.stringify({ ...all, alerts: next }), tenantId])
      // Recipients are personal data: the audit carries their number only.
      .audit('alerts.settings', `webhook=${next.host || 'none'} format=${next.format || '-'} emails=${(next.emails || []).length} events=${(next.events || DEFAULT_EVENTS).join(',')} slaHours=${next.slaHours || DEFAULT_SLA_HOURS}`, actor)
      .commit();
    return settings(tenantId);
  }

  async function noteDelivery(tenantId, channel, status) {
    // Only the outcome of the last attempt; no audit entry (the event itself is audited).
    // json_set touches only this key: a concurrent settings change (SSO,
    // audit, …) is never overwritten by a stale copy.
    const key = channel === 'email' ? 'lastEmailDelivery' : 'lastDelivery';
    await store.sql.batch([{ sql: `UPDATE tenants SET settings = json_set(settings, '$.alerts.${key}', json(?)) WHERE id = ? AND json_type(settings, '$.alerts') = 'object'`,
      params: [JSON.stringify({ at: iso(now()), status }), tenantId] }]);
  }

  const channelsOf = a => [...(a.sealedUrl ? ['webhook'] : []), ...(emailCfg && (a.emails || []).length ? ['email'] : [])];

  /** One delivery attempt on one channel, as configured right now. → { status, retry } */
  async function attempt(tenantId, channel, a, event, message, id, at) {
    const info = await store.tenant(tenantId).info().catch(() => null);
    const link = message.path && publicUrl ? new URL(message.path, publicUrl).toString() : null;
    const full = { id, event, link, tenant: { id: tenantId, name: info && info.name ? info.name : tenantId }, at, ...message };
    let req;
    if (channel === 'webhook') {
      const url = await decryptSecret(secretsKey, a.sealedUrl, { tenantId, purpose: PURPOSE });
      req = { url, headers: { 'content-type': 'application/json', 'user-agent': 'AccessX-alerts/1' }, body: formatMessage(a.format || 'json', full) };
    } else {
      req = emailRequest(emailCfg, a.emails, formatEmail(full), id);
    }
    try {
      const res = await fetch(req.url, {
        method: 'POST', headers: req.headers, body: JSON.stringify(req.body),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined, redirect: 'manual',
      });
      if (res.status >= 200 && res.status < 300) return { status: 'delivered', retry: false };
      return { status: `failed: HTTP ${res.status}`, retry: retryableHttp(res.status) };
    } catch (error) {
      return { status: `failed: ${String(error.message || error).slice(0, 80)}`, retry: true };
    }
  }

  async function enqueue(tenantId, channel, event, message, id, at, lastError) {
    const n = (await store.sql.first('SELECT COUNT(*) AS n FROM alert_outbox WHERE tenant_id = ?', [tenantId])).n;
    if (n >= OUTBOX_CAP) { log('alert outbox full', tenantId, event); return false; }
    await store.sql.batch([{
      sql: 'INSERT INTO alert_outbox (tenant_id, id, channel, event, message, created_at, attempts, next_at, last_error) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      params: [tenantId, `${id}:${channel}`, channel, event, JSON.stringify({ ...message, at }), at, iso(now() + RETRY.baseMs), lastError],
    }]);
    return true;
  }

  /**
   * Never throws. Returns 'delivered' | 'failed: …' | 'skipped: …' for a single
   * channel, or 'webhook: …; email: …' when both are configured.
   * `force` (test alert): ignore the event filter, never queue a retry.
   */
  async function send(tenantId, event, message, { force = false } = {}) {
    try {
      const a = await read(tenantId);
      const channels = channelsOf(a);
      if (!channels.length) return 'skipped: no channel';
      if (!force && !(a.events || DEFAULT_EVENTS).includes(event)) return 'skipped: event disabled';
      if (channels.includes('webhook') && !secretsKey) return 'skipped: SECRETS_KEY missing';
      const id = uid();
      const at = iso(now());
      const out = [];
      for (const channel of channels) {
        const r = await attempt(tenantId, channel, a, event, message, id, at);
        let status = r.status;
        if (r.retry && !force && await enqueue(tenantId, channel, event, message, id, at, r.status).catch(() => false)) status += ' (will retry)';
        if (r.status !== 'delivered') log('alert delivery', tenantId, event, channel, status);
        await noteDelivery(tenantId, channel, status).catch(() => {});
        out.push([channel, status]);
      }
      return out.length === 1 ? out[0][1] : out.map(([c, st]) => `${c}: ${st}`).join('; ');
    } catch (error) {
      log('alert error', tenantId, event, error.message);
      return `failed: ${String(error.message || error).slice(0, 80)}`;
    }
  }

  /** Retry due outbox entries (scheduled maintenance, inside the tenant's queue). Never throws. */
  async function flush(tenantId, { limit = 20 } = {}) {
    const res = { retried: 0, delivered: 0, dropped: 0, pending: 0 };
    try {
      const due = await store.sql.all('SELECT * FROM alert_outbox WHERE tenant_id = ? AND next_at <= ? ORDER BY next_at LIMIT ?', [tenantId, iso(now()), limit]);
      if (!due.length) return res;
      const a = await read(tenantId);
      const dropped = [];
      for (const row of due) {
        res.retried++;
        const del = { sql: 'DELETE FROM alert_outbox WHERE tenant_id = ? AND id = ?', params: [tenantId, row.id] };
        if (!channelsOf(a).includes(row.channel) || (row.channel === 'webhook' && !secretsKey)) { await store.sql.batch([del]); continue; } // channel removed meanwhile
        const { at, ...message } = JSON.parse(row.message);
        const r = await attempt(tenantId, row.channel, a, row.event, message, row.id.split(':')[0], at);
        const attempts = row.attempts + 1;
        if (r.status === 'delivered') {
          res.delivered++;
          await store.sql.batch([del]);
          await noteDelivery(tenantId, row.channel, `delivered (retry ${attempts - 1})`).catch(() => {});
        } else if (r.retry && attempts < RETRY.maxAttempts) {
          await store.sql.batch([{ sql: 'UPDATE alert_outbox SET attempts = ?, next_at = ?, last_error = ? WHERE tenant_id = ? AND id = ?',
            params: [attempts, iso(now() + Math.min(RETRY.baseMs * 2 ** (attempts - 1), RETRY.capMs)), r.status, tenantId, row.id] }]);
          await noteDelivery(tenantId, row.channel, `${r.status} (will retry)`).catch(() => {});
        } else {
          res.dropped++;
          await store.sql.batch([del]);
          await noteDelivery(tenantId, row.channel, `${r.status} (gave up)`).catch(() => {});
          dropped.push(`${row.id} ${row.channel} ${row.event} after ${attempts} attempts: ${r.status}`);
        }
      }
      if (dropped.length) {
        const u = store.tenant(tenantId).unit();
        for (const d of dropped) u.audit('alerts.dropped', d, 'system');
        await u.commit();
      }
      res.pending = (await store.sql.first('SELECT COUNT(*) AS n FROM alert_outbox WHERE tenant_id = ?', [tenantId])).n;
    } catch (error) {
      log('alert flush failed', tenantId, error.message);
      res.error = String(error.message || error);
    }
    return res;
  }

  /**
   * One-off email to someone who is not an alert recipient (a visitor's code).
   * Deliberately NOT queued in the outbox: the message contains a door code and
   * codes are never stored. One attempt; the caller falls back to showing it.
   * Never throws. Returns 'delivered' | 'failed: …' | 'skipped: …'.
   */
  async function emailTo(to, { subject, text }, id) {
    if (!emailCfg) return 'skipped: email is not configured on this server';
    const req = emailRequest(emailCfg, [].concat(to), { subject, text }, id);
    try {
      const res = await fetch(req.url, {
        method: 'POST', headers: req.headers, body: JSON.stringify(req.body),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined, redirect: 'manual',
      });
      return res.status >= 200 && res.status < 300 ? 'delivered' : `failed: HTTP ${res.status}`;
    } catch (error) {
      return `failed: ${String(error.message || error).slice(0, 80)}`;
    }
  }

  return { settings, save, send, flush, slaHours, emailTo, emailAvailable: Boolean(emailCfg), EVENTS };
}

/** EMAIL_PROVIDER / EMAIL_API_KEY / EMAIL_FROM / EMAIL_API_BASE (tests) → createAlerts({ email }). */
const emailConfigFromEnv = env => (env.EMAIL_PROVIDER
  ? { provider: String(env.EMAIL_PROVIDER).toLowerCase(), apiKey: env.EMAIL_API_KEY || '', from: env.EMAIL_FROM || '', apiBase: env.EMAIL_API_BASE || '' }
  : {});

/** The alert sent when TTLock refuses a tenant's tokens. */
const needsReconnectMessage = ({ accountUid, why }) => ({
  title: 'TTLock account must be reconnected',
  text: 'TTLock refused this account\'s authorization (password changed or access revoked). Until an owner reconnects it, codes cannot be issued or revoked through the cloud — leavers keep working codes.',
  facts: [['TTLock account', `uid ${accountUid}`], ['Reason', why]],
  path: '/#settings',
});

module.exports = { emailConfigFromEnv, needsReconnectMessage, createAlerts, formatMessage, formatEmail, emailRequest, AlertsError, EVENTS, DEFAULT_SLA_HOURS, RETRY };
