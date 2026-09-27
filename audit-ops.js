/**
 * Audit anchoring, export and retention — runtime-agnostic.
 * ====================================================================
 *  anchor()   sign the tenant's current head (seq, hash), store it, record
 *             it in the chain, and POST a copy to the customer's webhook.
 *  exportRange()  entries + anchors + public key: everything an auditor
 *             needs to verify offline (scripts/verify-audit-export.js).
 *  purge()    retention. Deletes entries older than N days, but only below
 *             an anchor that left the building, and only by first writing
 *             a checkpoint (seq, hash) that verification then starts from.
 *             The DB trigger refuses any other delete.
 */
const auditCore = require('./audit-core');
const { anchorPayload, loadSigningKey } = require('./audit-anchor-core');

const DAY = 864e5;
const MIN_RETENTION_DAYS = 365;

class AuditOpsError extends Error {
  constructor(status, message) { super(message); this.name = 'AuditOpsError'; this.status = status; }
}

/** https only, no credentials, no loopback/private literals (SSRF). DNS rebinding: see docs. */
function checkWebhookUrl(raw, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new AuditOpsError(400, 'anchorWebhook must be a URL'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new AuditOpsError(400, 'anchorWebhook must use https');
  if (u.username || u.password) throw new AuditOpsError(400, 'anchorWebhook must not contain credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateV4 = /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  if (!allowHttp && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || privateV4.test(host) || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host))) {
    throw new AuditOpsError(400, 'anchorWebhook must be a public address');
  }
  return u.toString();
}

function createAuditOps({ store, signingKeyJson = '', fetchFn, log = () => {}, now = () => Date.now(), allowHttpWebhooks = false }) {
  const fetch = fetchFn || ((...a) => globalThis.fetch(...a));
  let keyPromise = null;
  const signingKey = () => (keyPromise ||= loadSigningKey(signingKeyJson).catch(error => { log('AUDIT_SIGNING_KEY unusable', error.message); return null; }));
  const auditSettings = async tenantId => (((await store.tenantSettings(tenantId)) || {}).audit) || {};

  async function publicKey() {
    const k = await signingKey();
    return k ? k.publicKey : null;
  }

  async function deliver(url, anchor, tenant) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'AccessX-audit-anchor/1' },
        body: JSON.stringify({ type: 'accessx.audit.anchor', tenant, ...anchor, publicKey: await publicKey() }),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
        redirect: 'manual',
      });
      return res.status >= 200 && res.status < 300 ? 'delivered' : `failed: HTTP ${res.status}`;
    } catch (error) {
      return `failed: ${String(error.message || error).slice(0, 80)}`;
    }
  }

  async function anchor(tenantId, { actor = 'system', force = false } = {}) {
    const t = store.tenant(tenantId);
    const head = await t.auditHead();
    if (!head.seq) return { skipped: 'the audit chain is empty' };
    const [last] = await t.anchors({ limit: 1 });
    if (last && last.seq === head.seq && !force) return { skipped: 'no new entries since the last anchor', anchor: last };
    if (last && last.seq === head.seq) return { skipped: 'this head is already anchored', anchor: last };
    // The anchor records itself in the chain; that entry alone is not "new activity".
    if (last && head.seq === last.seq + 1 && !force && (await t.auditEntry(head.seq) || {}).action === 'audit.anchor') {
      return { skipped: 'no new entries since the last anchor', anchor: last };
    }
    const createdAt = new Date(now()).toISOString();
    const key = await signingKey();
    const signature = key ? await key.sign(anchorPayload({ tenantId, seq: head.seq, hash: head.hash, at: createdAt })) : null;
    const rec = { seq: head.seq, hash: head.hash, createdAt, keyId: key ? key.keyId : null, signature };
    const settings = await auditSettings(tenantId);
    let deliveredTo = null;
    let deliveryStatus = 'none';
    if (settings.anchorWebhook) {
      deliveredTo = new URL(settings.anchorWebhook).host;
      const info = await t.info();
      deliveryStatus = await deliver(settings.anchorWebhook, rec, { id: tenantId, name: info ? info.name : tenantId });
    }
    try {
      await t.unit()
        .raw('INSERT INTO audit_anchors (tenant_id, seq, hash, created_at, key_id, signature, delivered_to, delivery_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [tenantId, rec.seq, rec.hash, createdAt, rec.keyId, signature, deliveredTo, deliveryStatus])
        .audit('audit.anchor', `seq=${rec.seq} hash=${rec.hash} key=${rec.keyId || 'unsigned'} delivery=${deliveredTo ? `${deliveredTo} ${deliveryStatus}` : 'none'}`, actor)
        .commit();
    } catch (error) {
      if (error && error.status === 409) return { skipped: 'anchored concurrently', anchor: (await t.anchors({ limit: 1 }))[0] };
      throw error;
    }
    return { anchor: { ...rec, deliveredTo, deliveryStatus } };
  }

  /** Daily job: anchor if the chain moved and the last anchor is older than a day. */
  async function maybeAnchor(tenantId) {
    const t = store.tenant(tenantId);
    const [last] = await t.anchors({ limit: 1 });
    if (last && now() - Date.parse(last.createdAt) < DAY) return { skipped: 'anchored within the last day' };
    return anchor(tenantId, { actor: 'system:anchor' });
  }

  async function saveSettings(tenantId, body, actor) {
    const settings = (await store.tenantSettings(tenantId)) || {};
    const cur = settings.audit || {};
    const next = { ...cur };
    if ('retentionDays' in body) {
      if (body.retentionDays === null) next.retentionDays = null;
      else {
        const d = Number(body.retentionDays);
        if (!Number.isInteger(d) || d < MIN_RETENTION_DAYS || d > 3650) throw new AuditOpsError(400, `retentionDays must be ${MIN_RETENTION_DAYS}..3650, or null to keep everything`);
        next.retentionDays = d;
      }
    }
    if ('anchorWebhook' in body) next.anchorWebhook = body.anchorWebhook ? checkWebhookUrl(body.anchorWebhook, { allowHttp: allowHttpWebhooks }) : null;
    await store.tenant(tenantId).unit()
      .raw('UPDATE tenants SET settings = ? WHERE id = ?', [JSON.stringify({ ...settings, audit: next }), tenantId])
      .audit('audit.settings', `retentionDays=${next.retentionDays || 'forever'} anchorWebhook=${next.anchorWebhook ? new URL(next.anchorWebhook).host : 'none'}`, actor)
      .commit();
    return next;
  }

  /**
   * Retention purge. Everything older than retentionDays goes — but only
   * up to an anchor that was delivered outside AccessX (or, when run by
   * an owner, after they confirm they archived an export).
   */
  async function purge(tenantId, { actor = 'system:retention', acknowledgeExport = false } = {}) {
    const t = store.tenant(tenantId);
    const { retentionDays } = await auditSettings(tenantId);
    if (!retentionDays) throw new AuditOpsError(409, 'no retention period configured (audit settings → retentionDays)');
    const cutoffIso = new Date(now() - retentionDays * DAY).toISOString();
    const row = await store.sql.first('SELECT MAX(seq) AS seq FROM audit_events WHERE tenant_id = ? AND ts < ?', [tenantId, cutoffIso]);
    const cutoffSeq = row && row.seq ? Number(row.seq) : 0;
    const cp = await t.auditCheckpoint();
    if (!cutoffSeq || (cp && cutoffSeq <= cp.seq)) return { purged: 0, reason: `nothing older than ${retentionDays} days` };
    // Purge as far as an eligible anchor reaches: one delivered outside
    // AccessX, or (owner, after archiving an export) any anchor.
    const eligible = (await t.anchors({ limit: 1000, fromSeq: (cp ? cp.seq : 0) + 1 }))
      .filter(a => a.deliveryStatus === 'delivered' || acknowledgeExport);
    const reach = eligible.length ? Math.max(...eligible.map(a => a.seq)) : 0;
    const purgeTo = Math.min(cutoffSeq, reach);
    if (!purgeTo || (cp && purgeTo <= cp.seq)) {
      throw new AuditOpsError(409, 'the entries to purge are not covered by an anchor delivered outside AccessX — configure anchorWebhook, or export the audit trail and confirm with acknowledgeExport:true');
    }
    const cover = eligible.filter(a => a.seq >= purgeTo).sort((a, b) => a.seq - b.seq)[0];
    const external = cover.deliveryStatus === 'delivered';
    const last = await t.auditEntry(purgeTo);
    const before = await store.sql.first('SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ? AND seq <= ?', [tenantId, purgeTo]);
    const at = new Date(now()).toISOString();
    await t.unit()
      .raw('INSERT INTO audit_checkpoints (tenant_id, seq, hash, created_at, anchor_seq) VALUES (?, ?, ?, ?, ?)', [tenantId, purgeTo, last.hash, at, cover.seq])
      .raw('DELETE FROM audit_events WHERE tenant_id = ? AND seq <= ?', [tenantId, purgeTo])
      .audit('audit.purge', `entries up to seq=${purgeTo} (${Number(before.n)} rows, older than ${cutoffIso.slice(0, 10)}) purged; checkpoint hash=${last.hash}; covered by anchor seq=${cover.seq}${external ? ` (${cover.deliveredTo})` : ' (export acknowledged)'}`, actor)
      .commit();
    return { purged: Number(before.n), checkpoint: { seq: purgeTo, hash: last.hash }, coveredByAnchor: cover.seq, heldBack: cutoffSeq - purgeTo };
  }

  /** Daily job: purge only when an externally delivered anchor covers the range. */
  async function maybePurge(tenantId) {
    const { retentionDays } = await auditSettings(tenantId);
    if (!retentionDays) return { skipped: 'no retention configured' };
    try { return await purge(tenantId); } catch (error) {
      if (error.status === 409) return { skipped: error.message };
      throw error;
    }
  }

  async function exportRange(tenantId, { fromSeq = 0, toSeq = null, limit = 5000 } = {}) {
    const t = store.tenant(tenantId);
    const [entries, checkpoint, info, head] = await Promise.all([t.auditRange({ fromSeq, toSeq, limit }), t.auditCheckpoint(), t.info(), t.auditHead()]);
    const first = entries[0];
    const lastE = entries[entries.length - 1];
    let verification = { ok: true, count: 0 };
    let anchoredStart = null;
    if (first) {
      verification = auditCore.verify(entries, { seq: first.seq - 1, hash: first.prevHash });
      if (first.seq === 1) anchoredStart = first.prevHash === auditCore.GENESIS ? 'genesis' : 'BROKEN (seq 1 does not start at genesis)';
      else if (checkpoint && first.seq === checkpoint.seq + 1) anchoredStart = first.prevHash === checkpoint.hash ? 'retention checkpoint' : 'BROKEN (does not chain onto the checkpoint)';
      else anchoredStart = 'segment (verify against the previous export or an anchor)';
    }
    const anchorList = first ? (await t.anchors({ limit: 1000, fromSeq: first.seq, toSeq: lastE.seq })).reverse() : [];
    return {
      format: 'accessx-audit-export-v1',
      tenant: { id: tenantId, name: info ? info.name : tenantId },
      exportedAt: new Date(now()).toISOString(),
      head,
      checkpoint,
      range: first ? { fromSeq: first.seq, toSeq: lastE.seq, startPrevHash: first.prevHash, anchoredStart } : null,
      nextFromSeq: lastE && lastE.seq < head.seq ? lastE.seq + 1 : null,
      verification,
      anchors: anchorList,
      publicKey: await publicKey(),
      entries,
    };
  }

  return { anchor, maybeAnchor, purge, maybePurge, exportRange, saveSettings, auditSettings, publicKey, checkWebhookUrl, MIN_RETENTION_DAYS };
}

module.exports = { createAuditOps, checkWebhookUrl, AuditOpsError, MIN_RETENTION_DAYS };
