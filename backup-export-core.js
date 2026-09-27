/**
 * Weekly D1 -> R2 export (R20). Replaces "remember to run npm run backup".
 *
 * The Worker's cron (every 15 min) calls maybeExport(): once a week, in a quiet
 * hour, it dumps the whole database as SQL (the same shape `wrangler d1 export`
 * writes), gzips it and puts it in the R2 bucket bound as BACKUPS:
 *
 *   d1/accessx-2026-09-27T17-00-00Z.sql.gz   (+ customMetadata: tables, rows, schema)
 *
 * and keeps the newest BACKUP_KEEP (default 8, i.e. two months). Restore test
 * any copy with `npm run backup -- verify FILE.sql.gz` (scripts/backup.js):
 * loads, integrity, schema, every tenant's audit chain, sealed secrets.
 *
 * What this is and is not:
 *  - D1 Time Travel (30 days on Workers Paid) stays the first tool for "undo the
 *    last hour". This export is the copy that survives a deleted database, a
 *    deleted account, or a mistake noticed after 30 days.
 *  - D1 has no snapshot across queries. The dump pages table by table, so a write
 *    landing mid-export can make it slightly inconsistent (an audit row newer than
 *    the tenant head). That is why it runs in a quiet hour and why `verify`
 *    re-checks every audit chain; a copy that fails verify is the signal to use
 *    Time Travel instead.
 *  - The dump holds personal data and sealed (not plain) secrets. Keep the bucket
 *    private; sealed secrets need the same SECRETS_KEY to be usable after restore.
 */
const PREFIX = 'd1/';
const PAGE_ROWS = 500;
const WEEK_MS = 7 * 24 * 3600e3;

const quoteId = name => `"${String(name).replace(/"/g, '""')}"`;

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : Array.isArray(v) ? Uint8Array.from(v) : null;
  if (bytes) return `X'${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}'`;
  return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
}

/**
 * The whole database as SQL text: tables, rows (paged by rowid), then indexes,
 * triggers and views (after the rows, so triggers do not fire on restore).
 * sqlite_* and Cloudflare's own _cf_* tables are skipped; the migrations table
 * (d1_migrations on D1, schema_migrations on Node) is kept: verify reads the
 * schema version from it.
 */
async function dumpSql(sql, { pageRows = PAGE_ROWS, write = null } = {}) {
  const objects = await sql.all("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name");
  // `write(text)` streams the dump page by page (exportBackup gzips as it goes,
  // so a million-row database never sits in Worker memory as text). Without it
  // the text is collected and returned.
  const parts = [];
  const stats = { tables: 0, rows: 0, bytes: 0 };
  const flush = async lines => { if (!lines.length) return; const t = `${lines.join('\n')}\n`; stats.bytes += t.length; if (write) await write(t); else parts.push(t); };
  await flush(['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;']);
  for (const t of objects.filter(o => o.type === 'table')) {
    stats.tables += 1;
    await flush([`${t.sql};`]);
    let after = -Infinity;
    for (;;) {
      const page = await sql.all(`SELECT rowid AS "__accessx_rowid", * FROM ${quoteId(t.name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [after === -Infinity ? -9007199254740991 : after, pageRows]);
      const out = [];
      for (const row of page) {
        after = row.__accessx_rowid;
        const cols = Object.keys(row).filter(c => c !== '__accessx_rowid');
        out.push(`INSERT INTO ${quoteId(t.name)} (${cols.map(quoteId).join(',')}) VALUES(${cols.map(c => literal(row[c])).join(',')});`);
      }
      await flush(out);
      stats.rows += page.length;
      if (page.length < pageRows) break;
    }
  }
  await flush([...objects.filter(o => o.type !== 'table').map(o => `${o.sql};`), 'COMMIT;']);
  const migTable = ['d1_migrations', 'schema_migrations'].find(n => objects.some(o => o.name === n)); // D1 | Node
  const schema = migTable ? String(((await sql.all(`SELECT name FROM ${migTable} ORDER BY name DESC LIMIT 1`))[0] || {}).name || '').replace(/\.sql$/, '') || null : null;
  return { text: write ? undefined : parts.join(''), ...stats, schema };
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const keyFor = now => `${PREFIX}accessx-${new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}.sql.gz`;

/** Exports in the bucket, newest first. */
async function listBackups(bucket) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: PREFIX, cursor, include: ['customMetadata'] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects
    .filter(o => /\.sql\.gz$/.test(o.key))
    .sort((a, b) => (a.key < b.key ? 1 : -1))
    .map(o => ({ key: o.key, bytes: o.size, uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : null, ...(o.customMetadata || {}) }));
}

/** Dump, compress, upload, prune. Returns what happened (never includes data). */
async function exportBackup({ sql, bucket, now = Date.now(), keep = 8 }) {
  const started = Date.now();
  const cs = new CompressionStream('gzip');
  const compressed = new Response(cs.readable).arrayBuffer(); // drained while we write
  const writer = cs.writable.getWriter();
  const enc = new TextEncoder();
  let dump;
  try {
    dump = await dumpSql(sql, { write: t => writer.write(enc.encode(t)) });
    await writer.close();
  } catch (error) {
    writer.abort(error).catch(() => {});
    compressed.catch(() => {});
    throw error;
  }
  const body = new Uint8Array(await compressed);
  const key = keyFor(now);
  await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/sql', contentEncoding: 'gzip' },
    customMetadata: { tables: String(dump.tables), rows: String(dump.rows), schema: String(dump.schema || ''), sqlBytes: String(dump.bytes) },
  });
  const all = await listBackups(bucket);
  const pruned = all.slice(Math.max(1, keep)).map(o => o.key);
  for (const k of pruned) await bucket.delete(k);
  return { key, tables: dump.tables, rows: dump.rows, schema: dump.schema, sqlBytes: dump.bytes, gzipBytes: body.length, pruned, ms: Date.now() - started };
}

/**
 * Cron entry: export when the newest copy is older than ~a week, only during
 * `hourUtc` (default 17 UTC = 03:00/04:00 Sydney). Other ticks list and return.
 */
async function maybeExport({ sql, bucket, now = Date.now(), hourUtc = 17, keep = 8, everyMs = WEEK_MS }) {
  if (new Date(now).getUTCHours() !== Number(hourUtc)) return { skipped: 'not the backup hour' };
  const [newest] = await listBackups(bucket);
  const age = newest && newest.uploaded ? now - Date.parse(newest.uploaded) : Infinity;
  if (age < everyMs - 3600e3) return { skipped: 'recent copy exists', newest: newest.key };
  return exportBackup({ sql, bucket, now, keep });
}

module.exports = { dumpSql, gzip, listBackups, exportBackup, maybeExport, keyFor, literal, PREFIX };
