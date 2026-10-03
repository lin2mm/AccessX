/**
 * SECRETS_KEY rotation: find every sealed value, report which key protects
 * it, and re-seal everything still on an older key with the primary key.
 *
 * Every write is a compare-and-set on the old ciphertext, so a value changed
 * meanwhile (token refreshed, webhook replaced, code collected) is left alone,
 * never overwritten. The re-seal is idempotent: run it again until `status()`
 * reports nothing left on old keys, and only then remove the old key.
 *
 * Sealed values (tenant id + purpose are the AES-GCM associated data):
 *   vendor_accounts.sealed                 vendor.ttlock
 *   tenants.settings.sso.clientSecretEnc   sso.clientSecret
 *   tenants.settings.alerts.sealedUrl      alerts-webhook
 *   approvals.sealed_code                  approval-code:<approval id>
 */
const { encryptSecret, decryptSecret, sealedKeyId, primaryKeyId, keyIds } = require('./secrets-core');

const SETTINGS_PATHS = [
  { kind: 'sso', path: '$.sso.clientSecretEnc', purpose: 'sso.clientSecret' },
  { kind: 'alerts', path: '$.alerts.sealedUrl', purpose: 'alerts-webhook' },
];

function createSecretsRotation({ store, secretsKey }) {
  const sql = store.sql;

  /** Every sealed value: { kind, tenantId, purpose, sealed, write(newSealed) } */
  async function* sealedValues() {
    for (const r of await sql.all('SELECT tenant_id, sealed FROM vendor_accounts WHERE sealed IS NOT NULL')) {
      yield {
        kind: 'vendor', tenantId: r.tenant_id, purpose: 'vendor.ttlock', sealed: r.sealed,
        write: s => ({ sql: 'UPDATE vendor_accounts SET sealed = ? WHERE tenant_id = ? AND sealed = ?', params: [s, r.tenant_id, r.sealed] }),
        check: () => sql.first('SELECT sealed AS v FROM vendor_accounts WHERE tenant_id = ?', [r.tenant_id]),
      };
    }
    for (const p of SETTINGS_PATHS) {
      for (const r of await sql.all(`SELECT id, json_extract(settings, '${p.path}') AS v FROM tenants WHERE json_type(settings, '${p.path}') = 'text'`)) {
        yield {
          kind: p.kind, tenantId: r.id, purpose: p.purpose, sealed: r.v,
          write: s => ({ sql: `UPDATE tenants SET settings = json_set(settings, '${p.path}', ?) WHERE id = ? AND json_extract(settings, '${p.path}') = ?`, params: [s, r.id, r.v] }),
          check: () => sql.first(`SELECT json_extract(settings, '${p.path}') AS v FROM tenants WHERE id = ?`, [r.id]),
        };
      }
    }
    for (const r of await sql.all('SELECT tenant_id, id, sealed_code FROM approvals WHERE sealed_code IS NOT NULL')) {
      yield {
        kind: 'approval', tenantId: r.tenant_id, purpose: `approval-code:${r.id}`, sealed: r.sealed_code,
        write: s => ({ sql: 'UPDATE approvals SET sealed_code = ? WHERE tenant_id = ? AND id = ? AND sealed_code = ?', params: [s, r.tenant_id, r.id, r.sealed_code] }),
        check: () => sql.first('SELECT sealed_code AS v FROM approvals WHERE tenant_id = ? AND id = ?', [r.tenant_id, r.id]),
      };
    }
  }

  /** Counts per key id, and per kind; `onOldKeys` must be 0 before an old key is removed. */
  async function status() {
    const primary = await primaryKeyId(secretsKey);
    const ring = await keyIds(secretsKey);
    const byKey = {}; const byKind = {};
    let total = 0; let onOldKeys = 0; let unknownKey = 0;
    for await (const v of sealedValues()) {
      const kid = sealedKeyId(v.sealed) || 'unrecognised';
      byKey[kid] = (byKey[kid] || 0) + 1;
      byKind[v.kind] = byKind[v.kind] || { total: 0, onOldKeys: 0 };
      byKind[v.kind].total++; total++;
      if (kid !== primary) { byKind[v.kind].onOldKeys++; onOldKeys++; }
      if (kid !== 'v1' && !ring.includes(kid)) unknownKey++;
    }
    return { primaryKeyId: primary, keyring: ring, total, onOldKeys, unknownKey, byKey, byKind, safeToDropOldKeys: onOldKeys === 0 };
  }

  /** Re-seal everything not on the primary key. Unreadable values are reported, never touched. */
  async function reseal({ actor = 'platform' } = {}) {
    const primary = await primaryKeyId(secretsKey);
    const out = { primaryKeyId: primary, resealed: 0, alreadyCurrent: 0, changedMeanwhile: 0, failed: [] };
    const perTenant = new Map();
    for await (const v of sealedValues()) {
      if (sealedKeyId(v.sealed) === primary) { out.alreadyCurrent++; continue; }
      let plain;
      try { plain = await decryptSecret(secretsKey, v.sealed, v); } catch (error) {
        out.failed.push({ tenantId: v.tenantId, kind: v.kind, reason: error.message.slice(0, 120) });
        continue;
      }
      const next = await encryptSecret(secretsKey, plain, v);
      await sql.batch([v.write(next)]);
      const after = await v.check();
      if (after && after.v === next) {
        out.resealed++;
        perTenant.set(v.tenantId, [...(perTenant.get(v.tenantId) || []), v.kind]);
      } else out.changedMeanwhile++; // the owner of the value wrote a fresh one — already on the primary key
    }
    for (const [tenantId, kinds] of perTenant) {
      const counts = kinds.reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {});
      await store.tenant(tenantId).unit()
        .audit('secrets.resealed', `key=${primary} ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ')}`, actor).commit();
    }
    return { ...out, status: await status() };
  }

  return { status, reseal };
}

module.exports = { createSecretsRotation };
