const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../lock-health-core');

const days = (start, levels) => levels.map((level, i) => ({ day: new Date(Date.parse(start) + i * 864e5).toISOString().slice(0, 10), level }));
const NOW = Date.parse('2026-10-20T12:00:00Z');

test('battery forecast: least squares since the last battery change; bands', () => {
  // 1 %/day from 60 → 41 over 20 days: 31 days to 10 %.
  const f = h.forecast(days('2026-10-01', Array.from({ length: 20 }, (_, i) => 60 - i)), NOW);
  assert.equal(f.level, 41);
  assert.equal(f.slopePerDay, -1);
  assert.equal(f.daysLeft, 31);
  assert.equal(f.band, 'ok');
  assert.equal(h.forecast(days('2026-10-01', Array.from({ length: 20 }, (_, i) => 50 - i)), NOW).band, 'forecast', '21 days left');
  assert.equal(h.forecast(days('2026-10-01', [19]), NOW).band, 'low', 'one reading is enough for a level band');
  assert.equal(h.forecast(days('2026-10-01', [9]), NOW).band, 'critical');
  assert.equal(h.forecast(days('2026-10-01', [80, 79, 81]), NOW).daysLeft, null, 'too short a span: no trend');
  assert.equal(h.forecast(days('2026-10-01', [80, 80, 80, 80, 80, 80, 80]), NOW).daysLeft, null, 'flat: no forecast');
  const r = h.forecast(days('2026-10-01', [30, 25, 20, 15, 100, 99, 99]), NOW);
  assert.equal(r.replacedOn, '2026-10-05');
  assert.equal(r.level, 99);
  assert.equal(r.band, 'ok');
  assert.equal(h.forecast([], NOW).band, 'ok');
  assert.equal(h.level('n/a'), null);
  assert.equal(h.level(101), null);
  assert.equal(h.level('42'), 42);
});

test('battery decision: alert only when the band gets worse, weekly while critical, reset on a new battery', () => {
  const f = band => ({ band, replacedOn: null });
  assert.deepEqual(h.batteryDecision(null, f('forecast')), { alert: true, state: 'worse' });
  assert.deepEqual(h.batteryDecision({ band: 'forecast' }, f('forecast')), { alert: false, state: 'same' });
  assert.deepEqual(h.batteryDecision({ band: 'forecast' }, f('low')), { alert: true, state: 'worse' });
  assert.deepEqual(h.batteryDecision({ band: 'low' }, f('forecast')), { alert: false, state: 'same' }, 'noise does not re-alert');
  assert.deepEqual(h.batteryDecision({ band: 'critical', alertedAt: new Date(NOW - 3 * 864e5).toISOString() }, f('critical'), NOW).alert, false);
  assert.deepEqual(h.batteryDecision({ band: 'critical', alertedAt: new Date(NOW - 8 * 864e5).toISOString() }, f('critical'), NOW), { alert: true, state: 'remind' });
  assert.deepEqual(h.batteryDecision({ band: 'low', replacedOn: null }, { band: 'ok', replacedOn: '2026-10-05' }), { alert: false, state: 'replaced' });
  assert.deepEqual(h.batteryDecision({ band: 'low' }, f('ok')), { alert: false, state: 'reset' });
});

test('business hours: Mon–Fri 08–18 at the site, time zone and DST aware', () => {
  const L = 'Europe/London';
  // Fri 2026-10-16 17:00 BST → Mon 2026-10-19 10:00 BST: 1 (Fri) + 2 (Mon) = 3.
  assert.equal(h.businessHoursBetween(Date.parse('2026-10-16T16:00:00Z'), Date.parse('2026-10-19T09:00:00Z'), L), 3);
  // A full weekday: 10.
  assert.equal(h.businessHoursBetween(Date.parse('2026-10-20T00:00:00Z'), Date.parse('2026-10-21T00:00:00Z'), L), 10);
  // Sydney: same UTC day is a different local day.
  // Sydney (AEDT, UTC+11): Thu 15 Oct 21:00Z = Fri 08:00 local, a full working day...
  assert.equal(h.businessHoursBetween(Date.parse('2026-10-15T21:00:00Z'), Date.parse('2026-10-16T07:00:00Z'), 'Australia/Sydney'), 10);
  // ...while the same UTC hours a day later are Saturday there, though Friday in UTC.
  assert.equal(h.businessHoursBetween(Date.parse('2026-10-16T21:00:00Z'), Date.parse('2026-10-17T07:00:00Z'), 'Australia/Sydney'), 0);
});

test('callback silence: needs a callback that once worked, enough business hours, no repeat for the same silence', () => {
  const tz = 'Europe/London';
  const lastAt = '2026-10-19T08:00:00.000Z'; // Mon 09:00 BST
  const now = Date.parse('2026-10-20T09:00:00Z'); // Tue 10:00 BST: 9 + 2 = 11 business hours
  assert.equal(h.callbackNeedsCheck({ lastAt, gatewayDoors: 2, timeZone: tz }, now), true);
  assert.equal(h.callbackNeedsCheck({ lastAt: null, gatewayDoors: 2, timeZone: tz }, now), false, 'never worked: settings page says so, no alert');
  assert.equal(h.callbackNeedsCheck({ lastAt, gatewayDoors: 0, timeZone: tz }, now), false, 'no gateway doors: TTLock cannot call back');
  assert.equal(h.callbackNeedsCheck({ lastAt, alertedFor: lastAt, gatewayDoors: 2, timeZone: tz }, now), false, 'already raised for this silence');
  assert.equal(h.callbackNeedsCheck({ lastAt, checkedAt: new Date(now - 10 * 60e3).toISOString(), gatewayDoors: 2, timeZone: tz }, now), false, 'checked 10 min ago');
  assert.equal(h.callbackNeedsCheck({ lastAt: '2026-10-16T16:00:00.000Z', gatewayDoors: 2, timeZone: tz }, Date.parse('2026-10-19T09:00:00Z')), false, 'a weekend is not silence');
  assert.deepEqual(h.missedRecords([{ serverDate: Date.parse(lastAt) + 30e3 }, { lockDate: Date.parse(lastAt) + 3600e3 }], lastAt).length, 1);
});
