/**
 * Input validation for collection writes — shared by server and worker.
 * Allow-list per collection: unknown fields are rejected, types and
 * lengths are enforced, and references must point at existing records.
 * Bad data is refused at the door instead of crashing the policy engine
 * (or becoming stored XSS) later.
 */
const policy = require('./policy-core');
const rbac = require('./rbac-core');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; this.status = 400; }
}
const fail = message => { throw new ValidationError(message); };

const str = (max, { required = false } = {}) => (v, field) => {
  if (v === undefined || v === null || v === '') {
    if (required) fail(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') fail(`${field} must be a string`);
  const t = v.trim();
  if (required && !t) fail(`${field} is required`);
  if (t.length > max) fail(`${field} must be at most ${max} characters`);
  // Control characters have no business in names and break logs/CSV exports.
  if (/[\u0000-\u001f\u007f]/.test(t)) fail(`${field} contains control characters`);
  return t;
};
const bool = () => (v, field) => {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') fail(`${field} must be true or false`);
  return v;
};
const instant = () => (v, field) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) fail(`${field} must be an ISO date/time`);
  return new Date(v).toISOString();
};
const ref = (collection, { required = false } = {}) => (v, field, db) => {
  if (v === undefined || v === null || v === '') {
    if (required) fail(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || !(db[collection] || []).some(x => x.id === v)) fail(`${field} does not match an existing ${collection} record`);
  return v;
};
const refs = collection => (v, field, db) => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 50) fail(`${field} must be an array (max 50)`);
  return [...new Set(v.map((x, i) => ref(collection, { required: true })(x, `${field}[${i}]`, db)))];
};
const email = () => (v, field) => {
  const t = str(200)(v, field);
  if (t !== undefined && !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(t)) fail(`${field} is not a valid email`);
  return t;
};
const timezone = () => (v, field) => {
  if (v === undefined) return undefined;
  if (!policy.isValidTimeZone(v)) fail(`${field} must be an IANA time zone like "Europe/London"`);
  return v;
};
const lockIds = () => (v, field) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 500) fail(`${field} must be an array (max 500)`);
  return [...new Set(v.map((x, i) => {
    const n = Number(x);
    if (!Number.isSafeInteger(n) || n <= 0) fail(`${field}[${i}] must be a positive integer`);
    return n;
  }))];
};
const windows = () => (v, field) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 28) fail(`${field} must be an array (max 28)`);
  return v.map((w, i) => {
    const f = `${field}[${i}]`;
    if (!w || typeof w !== 'object') fail(`${f} must be an object`);
    if (!Array.isArray(w.days) || !w.days.length || w.days.some(d => !Number.isInteger(d) || d < 1 || d > 7)) {
      fail(`${f}.days must list ISO weekdays 1 (Mon) .. 7 (Sun)`);
    }
    if (!HHMM.test(w.from || '') || !HHMM.test(w.to || '')) fail(`${f}.from/to must be HH:MM`);
    return { days: [...new Set(w.days)].sort(), from: w.from, to: w.to };
  });
};
const day = () => (v, field) => {
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v))) fail(`${field} must be YYYY-MM-DD`);
  return v;
};
const perms = () => (v, field) => {
  if (!Array.isArray(v)) fail(`${field} must be an array`);
  for (const p of v) if (p !== '*' && !rbac.PERMS[p]) fail(`${field}: unknown permission "${p}"`);
  return [...new Set(v)];
};

const SCHEMAS = {
  sites: { name: str(100, { required: true }), address: str(200), timezone: timezone() },
  doorGroups: { name: str(100, { required: true }), siteId: ref('sites', { required: true }), lockIds: lockIds(), sensitive: bool() },
  // siteId: the site this group belongs to (omit = cross-site group, managed by all-site operators only)
  userGroups: { name: str(100, { required: true }), siteId: ref('sites') },
  users: {
    name: str(100, { required: true }), email: email(), groupIds: refs('userGroups'),
    suspended: bool(), validFrom: instant(), validTo: instant(),
  },
  schedules: {
    name: str(100, { required: true }), denyOnHolidays: bool(), windows: windows(),
    validFrom: instant(), validTo: instant(),
  },
  assignments: {
    userGroupId: ref('userGroups', { required: true }),
    doorGroupId: ref('doorGroups', { required: true }),
    scheduleId: ref('schedules'),
  },
  holidays: { date: day(), name: str(100), siteId: ref('sites') },
  roles: { name: str(100, { required: true }), perms: perms() },
};

/** Returns a clean record (without id) or throws ValidationError. */
function validate(collection, body, db) {
  const schema = SCHEMAS[collection];
  if (!schema) fail(`unknown collection ${collection}`);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('expected a JSON object');
  const unknown = Object.keys(body).filter(k => k !== 'id' && !schema[k]);
  if (unknown.length) fail(`unknown field(s): ${unknown.join(', ')}`);
  const out = {};
  for (const [field, check] of Object.entries(schema)) {
    const value = check(body[field], field, db);
    if (value !== undefined) out[field] = value;
  }
  if (out.validFrom && out.validTo && out.validFrom >= out.validTo) fail('validFrom must be before validTo');
  return out;
}

const REFERENCES = {
  sites: [['doorGroups', 'siteId'], ['holidays', 'siteId'], ['userGroups', 'siteId']],
  userGroups: [['users', 'groupIds'], ['assignments', 'userGroupId']],
  doorGroups: [['assignments', 'doorGroupId']],
  schedules: [['assignments', 'scheduleId']],
};

/** Records that still point at collection/id (deleting it would dangle). */
function referencedBy(collection, id, db) {
  const hits = [];
  for (const [other, field] of REFERENCES[collection] || []) {
    for (const item of db[other] || []) {
      const v = item[field];
      if (v === id || (Array.isArray(v) && v.includes(id))) hits.push(`${other}/${item.id}`);
    }
  }
  return hits;
}

/** Minimal HTML escaping for server-built HTML (AI answers). */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { validate, ValidationError, SCHEMAS, escapeHtml, referencedBy };
