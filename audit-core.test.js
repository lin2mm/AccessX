const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const audit = require('./audit-core');

test('pure-JS SHA-256 matches Node crypto (ASCII, UTF-8, block boundaries)', () => {
  const samples = ['', 'abc', 'é中文🔐', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)];
  for (const s of samples) {
    assert.equal(audit.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 10)));
  }
});

function chain(n) {
  const pending = Array.from({ length: n }, (_, i) => audit.pending('act', `detail ${i}`, 'op', `2026-01-01T00:00:0${i}Z`, `id${i}`));
  return audit.seal(null, pending);
}

test('sealed chains verify and expose the head', () => {
  const entries = chain(5);
  const result = audit.verify(entries);
  assert.equal(result.ok, true);
  assert.equal(result.head.seq, 5);
  assert.equal(result.head.hash, entries[4].hash);
  // continuing from the head keeps the chain valid
  const more = audit.seal(result.head, [audit.pending('act', 'six')]);
  assert.equal(audit.verify([...entries, ...more]).ok, true);
});

test('edits, deletions and reordering are detected at the right entry', () => {
  const edited = chain(5);
  edited[2].detail = 'nothing to see here';
  assert.deepEqual([audit.verify(edited).ok, audit.verify(edited).brokenAt], [false, 3]);

  const deleted = chain(5);
  deleted.splice(1, 1);
  assert.deepEqual([audit.verify(deleted).ok, audit.verify(deleted).brokenAt], [false, 2]);

  const swapped = chain(5);
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.equal(audit.verify(swapped).ok, false);

  // Rewriting one entry AND its hash still breaks the next link.
  const rehashed = chain(5);
  rehashed[2].detail = 'forged';
  rehashed[2].hash = audit.entryHash(rehashed[2]);
  assert.deepEqual([audit.verify(rehashed).ok, audit.verify(rehashed).brokenAt], [false, 4]);
});

test('legacy newest-first logs import oldest-first with a marker', () => {
  const legacy = [{ id: 'b', ts: '2026-01-02', action: 'second', detail: '' }, { id: 'a', ts: '2026-01-01', action: 'first', detail: '' }];
  const imported = audit.fromLegacy(legacy);
  assert.deepEqual(imported.map(e => e.action), ['first', 'second', 'audit.migrated']);
  assert.deepEqual(audit.fromLegacy([]), []);
});
