/**
 * Alerts: push the few events a human must act on to the customer's chat.
 *
 *   approval_requested  a four-eyes request waits for a second person
 *   removal_overdue     a revoked code is still on an offline lock past the SLA
 *   revoke_failed       the cloud could not revoke a code (it still works)
 *   break_glass         someone signed in with a token while SSO is enforced
 *   vendor_needs_reconnect  TTLock refused the account's tokens: revocations
 *                       stop until an owner reconnects
 *   visitor_arrived     (opt-in, names a person) a visitor used their code
 *   lock_alarm          a lock reported tamper, a forced opening or a keypad
 *                       locked after repeated wrong codes
 *   door_left_open      (opt-in) a door sensor reported the door left open
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
 *
 * Daily summary (digest): an owner may batch the noisy, non-urgent events
 * (DIGEST_EVENTS) into one message a day at a local hour. Batched items wait
 * in the outbox as channel 'digest' rows due at the summary time; the summary
 * is then sent like any alert (with retries). Security events — break-glass,
 * failed revocations, a disconnected TTLock account — are always instant.
 * A message may carry `ref` (e.g. a visit id): forget(ref) deletes waiting
 * rows, so erasing a visitor also erases their name from pending alerts.
 */
const { encryptSecret, decryptSecret } = require('./secrets-core');
const { checkWebhookUrl } = require('./audit-ops');
const policy = require('./policy-core');

const EVENTS = ['approval_requested', 'removal_overdue', 'revoke_failed', 'break_glass', 'vendor_needs_reconnect', 'visitor_arrived', 'lock_alarm', 'door_left_open'];
// Informational, and they name people: channels get these only when an owner turns them on.
const OPT_IN_EVENTS = ['visitor_arrived', 'door_left_open'];
const DEFAULT_EVENTS = EVENTS.filter(e => !OPT_IN_EVENTS.includes(e));
// Events that existed before owners' choices were recorded with `eventsSeen`.
// A default-on event added later is enabled for an owner who saved a list
// before it existed (they never had the chance to untick it).
const LEGACY_SEEN = ['approval_requested', 'removal_overdue', 'revoke_failed', 'break_glass', 'vendor_needs_reconnect', 'visitor_arrived'];
const effectiveEvents = a => (a.events
  ? [...new Set([...a.events, ...DEFAULT_EVENTS.filter(e => !(a.eventsSeen || LEGACY_SEEN).includes(e))])].filter(e => EVENTS.includes(e))
  : DEFAULT_EVENTS);
const FORMATS = ['slack', 'teams', 'json'];
// Non-urgent events that may wait for the daily summary. Never: break_glass,
// revoke_failed, vendor_needs_reconnect (someone must act now).
const DIGEST_EVENTS = ['approval_requested', 'removal_overdue', 'visitor_arrived', 'door_left_open'];
const DIGEST_MAX_LINES = 40;
const EVENT_TITLES = {
  approval_requested: 'Approvals requested', removal_overdue: 'Codes still on offline locks',
  revoke_failed: 'Revocations failed', break_glass: 'Break-glass sign-ins',
  vendor_needs_reconnect: 'TTLock accounts to reconnect', visitor_arrived: 'Visitors arrived',
  lock_alarm: 'Lock alarms', door_left_open: 'Doors left open',
};

/** Next occurrence of `hour`:00 in `timeZone` strictly after `nowMs` (DST-safe). */
function nextDigestAt(hour, timeZone, nowMs) {
  const hh = String(hour).padStart(2, '0');
  let day = policy.localParts(new Date(nowMs), timeZone).isoDate;
  for (let i = 0; i < 3; i++) {
    const at = policy.zonedTimeToDate(`${day}T${hh}:00`, timeZone).getTime();
    if (at > nowMs) return at;
    const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); day = d.toISOString().slice(0, 10);
  }
  return nowMs + 864e5;
}
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
    const outbox = await store.sql.first("SELECT COUNT(*) AS n, MIN(next_at) AS next FROM alert_outbox WHERE tenant_id = ? AND channel != 'digest'", [tenantId]);
    const waiting = await store.sql.first("SELECT COUNT(*) AS n, MIN(next_at) AS next FROM alert_outbox WHERE tenant_id = ? AND channel = 'digest'", [tenantId]);
    return {
      configured: Boolean(a.sealedUrl || (emailCfg && (a.emails || []).length)), format: a.format || null, host: a.host || null,
      emails: a.emails || [], emailAvailable: Boolean(emailCfg), emailProvider: emailCfg ? emailCfg.provider : null,
      events: effectiveEvents(a), slaHours: a.slaHours || DEFAULT_SLA_HOURS,
      lastDelivery: a.lastDelivery || null, lastEmailDelivery: a.lastEmailDelivery || null,
      retrying: { count: outbox.n || 0, nextAt: outbox.next || null },
      digest: a.digest || null, digestEvents: DIGEST_EVENTS,
      digestPending: { count: waiting.n || 0, nextAt: waiting.next || (a.digest ? iso(nextDigestAt(a.digest.hour, a.digest.timeZone, now())) : null) },
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
      next.eventsSeen = EVENTS;
    }
    if ('digest' in body) {
      const d = body.digest;
      if (d === null || (d && Array.isArray(d.events) && !d.events.length)) delete next.digest;
      else {
        if (!d || typeof d !== 'object' || !Array.isArray(d.events)) throw new AlertsError(400, 'digest must be {events, hour, timeZone} or null');
        const bad = d.events.filter(e => !DIGEST_EVENTS.includes(e));
        if (bad.length) throw new AlertsError(400, `only ${DIGEST_EVENTS.join(', ')} can wait for the daily summary (${bad.join(', ')} must be sent at once)`);
        if (!Number.isInteger(d.hour) || d.hour < 0 || d.hour > 23) throw new AlertsError(400, 'digest.hour must be a whole hour 0-23');
        if (!policy.isValidTimeZone(d.timeZone)) throw new AlertsError(400, 'digest.timeZone must be an IANA time zone, e.g. Europe/London');
        next.digest = { events: [...new Set(d.events)], hour: d.hour, timeZone: d.timeZone };
      }
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
      .audit('alerts.settings', `webhook=${next.host || 'none'} format=${next.format || '-'} emails=${(next.emails || []).length} events=${effectiveEvents(next).join(',')} slaHours=${next.slaHours || DEFAULT_SLA_HOURS}${next.digest ? ` digest=${next.digest.events.join(',')}@${String(next.digest.hour).padStart(2, '0')}:00 ${next.digest.timeZone}` : ''}`, actor)
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

  async function enqueueRow(tenantId, rowId, channel, event, message, at, nextAt, attempts, lastError) {
    const n = (await store.sql.first('SELECT COUNT(*) AS n FROM alert_outbox WHERE tenant_id = ?', [tenantId])).n;
    if (n >= OUTBOX_CAP) { log('alert outbox full', tenantId, event); return false; }
    await store.sql.batch([{
      sql: 'INSERT INTO alert_outbox (tenant_id, id, channel, event, message, created_at, attempts, next_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [tenantId, rowId, channel, event, JSON.stringify({ ...message, at }), at, attempts, nextAt, lastError],
    }]);
    return true;
  }
  const enqueue = (tenantId, channel, event, message, id, at, lastError) =>
    enqueueRow(tenantId, `${id}:${channel}`, channel, event, message, at, iso(now() + RETRY.baseMs), 1, lastError);

  /**
   * Never throws. Returns 'delivered' | 'failed: …' | 'skipped: …' for a single
   * channel, or 'webhook: …; email: …' when both are configured.
   * `force` (test alert): ignore the event filter, never queue a retry.
   */
  async function send(tenantId, event, message, { force = false, internal = false } = {}) {
    try {
      const a = await read(tenantId);
      const channels = channelsOf(a);
      if (!channels.length) return 'skipped: no channel';
      if (!force && !internal && !effectiveEvents(a).includes(event)) return 'skipped: event disabled';
      if (channels.includes('webhook') && !secretsKey) return 'skipped: SECRETS_KEY missing';
      const id = uid();
      const at = iso(now());
      if (!force && !internal && a.digest && a.digest.events.includes(event)) {
        const due = iso(nextDigestAt(a.digest.hour, a.digest.timeZone, now()));
        if (await enqueueRow(tenantId, `${id}:digest`, 'digest', event, message, at, due, 0, null).catch(() => false)) return `waiting for the daily summary (${due})`;
        // Outbox full: better an instant alert than none.
      }
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
      const due = await store.sql.all("SELECT * FROM alert_outbox WHERE tenant_id = ? AND channel != 'digest' AND next_at <= ? ORDER BY next_at LIMIT ?", [tenantId, iso(now()), limit]);
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
      res.pending = (await store.sql.first("SELECT COUNT(*) AS n FROM alert_outbox WHERE tenant_id = ? AND channel != 'digest'", [tenantId])).n;
    } catch (error) {
      log('alert flush failed', tenantId, error.message);
      res.error = String(error.message || error);
    }
    return res;
  }

  /**
   * Send the daily summary once its time has come (scheduled maintenance, in
   * the tenant's queue). Everything waiting is sent together, oldest first,
   * even if the digest was switched off meanwhile. Never throws.
   */
  async function flushDigest(tenantId) {
    try {
      const first = await store.sql.first("SELECT MIN(next_at) AS due FROM alert_outbox WHERE tenant_id = ? AND channel = 'digest'", [tenantId]);
      if (!first || !first.due || first.due > iso(now())) return null;
      const rows = await store.sql.all("SELECT * FROM alert_outbox WHERE tenant_id = ? AND channel = 'digest' ORDER BY created_at LIMIT ?", [tenantId, OUTBOX_CAP]);
      const a = await read(tenantId);
      const tz = a.digest ? a.digest.timeZone : 'UTC';
      const items = rows.map(r => ({ event: r.event, ...JSON.parse(r.message) }));
      const counts = {};
      for (const it of items) counts[it.event] = (counts[it.event] || 0) + 1;
      const lines = [];
      for (const event of Object.keys(counts)) {
        lines.push(`${EVENT_TITLES[event] || event} (${counts[event]})`);
        for (const it of items.filter(x => x.event === event)) {
          if (lines.length >= DIGEST_MAX_LINES) break;
          lines.push(`• ${policy.localParts(new Date(it.at), tz).label.replace(/ \S+$/, '')} ${it.text || it.title}`);
        }
      }
      if (items.length + Object.keys(counts).length > lines.length) lines.push(`… and more: see the audit log.`);
      const status = await send(tenantId, 'digest', {
        title: `Daily summary: ${items.length} alert${items.length === 1 ? '' : 's'}`,
        text: lines.join('\n'), facts: Object.entries(counts).map(([e, n]) => [EVENT_TITLES[e] || e, String(n)]), path: '/#audit',
      }, { internal: true });
      const ids = rows.map(r => r.id);
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        await store.sql.batch([{ sql: `DELETE FROM alert_outbox WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(',')})`, params: [tenantId, ...chunk] }]);
      }
      return { items: items.length, status };
    } catch (error) {
      log('alert digest failed', tenantId, error.message);
      return { error: String(error.message || error) };
    }
  }

  /** Delete waiting alerts (retry or digest) whose message carries `ref` — personal-data erasure. */
  async function forget(tenantId, ref) {
    await store.sql.batch([{ sql: "DELETE FROM alert_outbox WHERE tenant_id = ? AND json_extract(message, '$.ref') = ?", params: [tenantId, String(ref)] }]);
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

  return { settings, save, send, flush, flushDigest, forget, slaHours, emailTo, emailAvailable: Boolean(emailCfg), EVENTS };
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

module.exports = { emailConfigFromEnv, needsReconnectMessage, createAlerts, formatMessage, formatEmail, emailRequest, AlertsError, EVENTS, DIGEST_EVENTS, DEFAULT_SLA_HOURS, RETRY, nextDigestAt };
