'use strict';
/**
 * Lock health: battery trends and a silent TTLock callback. Pure functions;
 * api-core stores the samples and sends the alerts.
 *
 * Battery. TTLock reports `electricQuantity` (0–100) on the lock list (as of
 * the lock's last sync) and on callback records. One sample per lock per day
 * is kept; a least-squares line over the samples since the last battery change
 * gives the drain rate and the day the lock reaches EMPTY_AT %. Bands only
 * escalate (ok → forecast → low → critical), so a battery produces at most
 * three alerts in its life, plus a weekly reminder while critical. A jump of
 * REPLACED_JUMP points or more is a battery change: the history restarts.
 *
 * Callback. The TTLock console takes one callback URL per app; if it is
 * changed, or TTLock stops calling, arrivals and alarms go quiet with no
 * error anywhere. After SILENT_BUSINESS_HOURS business hours (Mon–Fri
 * 08:00–18:00 at the site) without a callback, the gateway doors' records are
 * read from the cloud: records TTLock has but never sent us prove the
 * callback is broken (alert); no records means the doors were simply idle
 * (a holiday) and nothing is said.
 */

const DAY = 864e5;
const HOUR = 36e5;
const EMPTY_AT = 10;           // % at which TTLock locks start to fail/warn
const LOW_AT = 20;
const FORECAST_DAYS = 21;      // warn this many days before EMPTY_AT
const REPLACED_JUMP = 15;
const MIN_SAMPLES = 3;
const MIN_SPAN_DAYS = 5;
const KEEP_DAYS = 120;
const CRITICAL_REMIND_DAYS = 7;
const SILENT_BUSINESS_HOURS = 8;
const SILENT_RECHECK_MS = HOUR;
const BUSINESS = { from: 8, to: 18 };

const BANDS = ['ok', 'forecast', 'low', 'critical'];
const rank = b => Math.max(0, BANDS.indexOf(b));

const level = v => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) || n < 0 || n > 100 ? null : Math.round(n);
};
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

/** Samples since the last battery change (a jump up of REPLACED_JUMP points or more). */
function sinceReplacement(samples) {
  const s = [...samples].filter(x => level(x.level) !== null).sort((a, b) => (a.day < b.day ? -1 : 1));
  let start = 0;
  for (let i = 1; i < s.length; i++) if (s[i].level - s[i - 1].level >= REPLACED_JUMP) start = i;
  return { samples: s.slice(start), replacedOn: start ? s[start].day : null };
}

/**
 * @param samples [{ day: 'YYYY-MM-DD', level }]
 * @returns { level, slopePerDay, daysLeft, emptyOn, band, replacedOn }
 */
function forecast(samples, now = Date.now()) {
  const { samples: s, replacedOn } = sinceReplacement(samples);
  if (!s.length) return { level: null, slopePerDay: null, daysLeft: null, emptyOn: null, band: 'ok', replacedOn };
  const last = s[s.length - 1].level;
  let slope = null;
  const t0 = Date.parse(`${s[0].day}T00:00:00Z`);
  const xs = s.map(x => (Date.parse(`${x.day}T00:00:00Z`) - t0) / DAY);
  if (s.length >= MIN_SAMPLES && xs[xs.length - 1] >= MIN_SPAN_DAYS) {
    const n = s.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = s.reduce((a, b) => a + b.level, 0) / n;
    const num = xs.reduce((a, x, i) => a + (x - mx) * (s[i].level - my), 0);
    const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    slope = den ? num / den : null;
  }
  let daysLeft = null;
  if (last <= EMPTY_AT) daysLeft = 0;
  else if (slope !== null && slope < -0.05) daysLeft = Math.floor((last - EMPTY_AT) / -slope);
  const emptyOn = daysLeft === null ? null : dayOf(now + daysLeft * DAY);
  return { level: last, slopePerDay: slope === null ? null : Math.round(slope * 100) / 100, daysLeft, emptyOn, band: band(last, daysLeft), replacedOn };
}

function band(lvl, daysLeft) {
  if (lvl === null) return 'ok';
  if (lvl <= EMPTY_AT) return 'critical';
  if (lvl <= LOW_AT) return 'low';
  if (daysLeft !== null && daysLeft <= FORECAST_DAYS) return 'forecast';
  return 'ok';
}

/**
 * Alert when the band gets worse, or weekly while critical.
 * @param prev { band, alertedAt } stored state (or null)
 */
function batteryDecision(prev, f, now = Date.now()) {
  const was = (prev && prev.band) || 'ok';
  if (f.replacedOn && prev && prev.replacedOn !== f.replacedOn) return { alert: false, state: 'replaced' };
  if (f.band === 'ok') return { alert: false, state: was === 'ok' ? 'same' : 'reset' };
  if (rank(f.band) > rank(was)) return { alert: true, state: 'worse' };
  if (f.band === 'critical' && prev && prev.alertedAt && now - Date.parse(prev.alertedAt) >= CRITICAL_REMIND_DAYS * DAY) return { alert: true, state: 'remind' };
  return { alert: false, state: 'same' };
}

/** Local weekday/hour in a time zone (Intl only: works on Node and Workers). */
function localDayHour(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = t => (parts.find(p => p.type === t) || {}).value;
  return { weekday: get('weekday'), hour: Number(get('hour')) };
}

/** Whole business hours (Mon–Fri, 08:00–18:00 local) between two instants, capped at 14 days of scanning. */
function businessHoursBetween(fromMs, toMs, timeZone) {
  let n = 0;
  const end = Math.min(toMs, fromMs + 14 * DAY);
  for (let t = Math.ceil(fromMs / HOUR) * HOUR; t + HOUR <= end; t += HOUR) {
    const { weekday, hour } = localDayHour(t, timeZone);
    if (weekday !== 'Sat' && weekday !== 'Sun' && hour >= BUSINESS.from && hour < BUSINESS.to) n++;
  }
  return n;
}

/**
 * Should we look for records TTLock never sent? Only once the callback has
 * worked at least once (lastAt), it has been quiet long enough, and we have
 * not already raised it for this silence (alertedFor === lastAt).
 */
function callbackNeedsCheck({ lastAt, alertedFor, checkedAt, gatewayDoors, timeZone }, now = Date.now()) {
  if (!lastAt || !gatewayDoors) return false;
  if (alertedFor && alertedFor === lastAt) return false;
  if (checkedAt && now - Date.parse(checkedAt) < SILENT_RECHECK_MS) return false;
  return businessHoursBetween(Date.parse(lastAt), now, timeZone) >= SILENT_BUSINESS_HOURS;
}

/** Records the cloud has that reached it after our last callback (with a minute of slack). */
function missedRecords(records, lastAt) {
  const after = Date.parse(lastAt) + 60e3;
  return [].concat(records || []).filter(r => Number(r.serverDate || r.lockDate) > after);
}

module.exports = {
  EMPTY_AT, LOW_AT, FORECAST_DAYS, REPLACED_JUMP, KEEP_DAYS, SILENT_BUSINESS_HOURS, BANDS,
  level, dayOf, forecast, band, batteryDecision, businessHoursBetween, callbackNeedsCheck, missedRecords,
};
