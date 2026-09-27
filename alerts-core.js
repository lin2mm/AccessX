/**
 * Alerts: push the few events a human must act on to the customer's chat.
 *
 *   approval_requested  a four-eyes request waits for a second person
 *   removal_overdue     a revoked code is still on an offline lock past the SLA
 *   revoke_failed       the cloud could not revoke a code (it still works)
 *   break_glass         someone signed in with a token while SSO is enforced
 *
 * Formats: Slack incoming webhook ({text}), Microsoft Teams Workflows
 * ("Post to a channel when a webhook request is received": an Adaptive Card
 * attachment — the old Office 365 connector format is retired), or plain JSON
 * for a SIEM / ticketing system.
 *
 * The webhook URL is a bearer secret (Slack's path, Teams' `sig=`), so it is
 * sealed with SECRETS_KEY and never returned — only its host.
 * Delivery is best effort with a short timeout: an alert must never block or
 * fail the change that caused it. The audit log remains the record.
 */
const { encryptSecret, decryptSecret } = require('./secrets-core');
const { checkWebhookUrl } = require('./audit-ops');

const EVENTS = ['approval_requested', 'removal_overdue', 'revoke_failed', 'break_glass'];
const FORMATS = ['slack', 'teams', 'json'];
const DEFAULT_SLA_HOURS = 48;
const PURPOSE = 'alerts-webhook';

class AlertsError extends Error {
  constructor(status, message) { super(message); this.name = 'AlertsError'; this.status = status; }
}

/** Message body for each chat format. facts: [[label, value], …] */
function formatMessage(format, { event, title, text, facts = [], link, tenant, at }) {
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
  return { type: `accessx.alert.${event}`, tenant, at, title, text, facts: Object.fromEntries(facts), link: link || null };
}

function createAlerts({ store, secretsKey = '', fetchFn, allowHttp = false, publicUrl = '', log = () => {}, now = () => Date.now() }) {
  const fetch = fetchFn || ((...a) => globalThis.fetch(...a));
  const read = async tenantId => (((await store.tenantSettings(tenantId)) || {}).alerts) || {};

  async function settings(tenantId) {
    const a = await read(tenantId);
    return {
      configured: Boolean(a.sealedUrl), format: a.format || null, host: a.host || null,
      events: a.events || EVENTS, slaHours: a.slaHours || DEFAULT_SLA_HOURS,
      lastDelivery: a.lastDelivery || null, availableEvents: EVENTS, formats: FORMATS, secretsKeyConfigured: Boolean(secretsKey),
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
      .audit('alerts.settings', `webhook=${next.host || 'none'} format=${next.format || '-'} events=${(next.events || EVENTS).join(',')} slaHours=${next.slaHours || DEFAULT_SLA_HOURS}`, actor)
      .commit();
    return settings(tenantId);
  }

  async function noteDelivery(tenantId, status) {
    // Only the outcome of the last attempt; no audit entry (the event itself is audited).
    // json_set touches only this key: a concurrent settings change (SSO,
    // audit, …) is never overwritten by a stale copy.
    await store.sql.batch([{ sql: "UPDATE tenants SET settings = json_set(settings, '$.alerts.lastDelivery', json(?)) WHERE id = ? AND json_type(settings, '$.alerts') = 'object'",
      params: [JSON.stringify({ at: new Date(now()).toISOString(), status }), tenantId] }]);
  }

  /** Never throws. Returns 'delivered' | 'failed: …' | 'skipped: …'. */
  async function send(tenantId, event, message, { force = false } = {}) {
    try {
      const a = await read(tenantId);
      if (!a.sealedUrl) return 'skipped: no webhook';
      if (!force && !(a.events || EVENTS).includes(event)) return 'skipped: event disabled';
      if (!secretsKey) return 'skipped: SECRETS_KEY missing';
      const url = await decryptSecret(secretsKey, a.sealedUrl, { tenantId, purpose: PURPOSE });
      const info = await store.tenant(tenantId).info().catch(() => null);
      const link = message.path && publicUrl ? new URL(message.path, publicUrl).toString() : null;
      const body = formatMessage(a.format || 'json', { event, link, tenant: { id: tenantId, name: info && info.name ? info.name : tenantId }, at: new Date(now()).toISOString(), ...message });
      let status;
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'AccessX-alerts/1' }, body: JSON.stringify(body),
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined, redirect: 'manual',
        });
        status = res.status >= 200 && res.status < 300 ? 'delivered' : `failed: HTTP ${res.status}`;
      } catch (error) { status = `failed: ${String(error.message || error).slice(0, 80)}`; }
      if (status !== 'delivered') log('alert delivery', tenantId, event, status);
      await noteDelivery(tenantId, status).catch(() => {});
      return status;
    } catch (error) {
      log('alert error', tenantId, event, error.message);
      return `failed: ${String(error.message || error).slice(0, 80)}`;
    }
  }

  return { settings, save, send, slaHours, EVENTS };
}

module.exports = { createAlerts, formatMessage, AlertsError, EVENTS, DEFAULT_SLA_HOURS };
