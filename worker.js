import aclDefaults from './data/acl.json';
import mirrorDefaults from './data/mirror.json';
import policy from './policy-core.js';
import rbac from './rbac-core.js';
import creds from './credentials-core.js';
import auditCore from './audit-core.js';
import validation from './validate-core.js';

const h = validation.escapeHtml;

const DEMO_LOCKS = [
  { lockId: 9001, lockAlias: 'Main Entrance', electricQuantity: 78, hasGateway: 1, groupName: 'Riverside Office' },
  { lockId: 9002, lockAlias: 'Server Room', electricQuantity: 91, hasGateway: 1, groupName: 'Riverside Office' },
  { lockId: 9003, lockAlias: 'Warehouse Side Door', electricQuantity: 42, hasGateway: 1, groupName: 'Riverside Office' },
  { lockId: 9004, lockAlias: 'Cleaner Cupboard', electricQuantity: 15, hasGateway: 0, groupName: 'Riverside Office' },
  { lockId: 9101, lockAlias: 'Gym Front Door', electricQuantity: 66, hasGateway: 1, groupName: 'Northgate Gym' },
  { lockId: 9102, lockAlias: 'Gym Staff Office', electricQuantity: 88, hasGateway: 1, groupName: 'Northgate Gym' },
  { lockId: 9201, lockAlias: 'Storage Block A Gate', electricQuantity: 55, hasGateway: 1, groupName: 'Selfstore Depot' },
];

const COLLECTIONS = new Set([
  'sites', 'doorGroups', 'userGroups', 'users', 'schedules',
  'assignments', 'holidays', 'roles',
]);
const RECORD_TYPES = {
  1: 'App unlock', 4: 'Passcode unlock', 7: 'IC card unlock', 8: 'Fingerprint unlock',
  9: 'Wireless keypad', 10: 'Auto lock', 11: 'App lock', 12: 'Gateway unlock',
  46: 'Remote unlock', 47: 'Remote lock', 55: 'Remote control (fob)',
  '-5': 'Face unlock', '-4': 'QR code unlock', 123: 'Network exception',
};

const failedLogins = new Map();
const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...headers },
  });
}

function ok(data = {}) {
  return { ok: true, demo: true, ...data };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const directoryCache = new Map();
async function operatorDirectory(env) {
  const cacheKey = `${env.ADMIN_TOKEN || ''}\u0000${env.OPERATORS || ''}`;
  if (!directoryCache.has(cacheKey)) {
    const adminHash = env.ADMIN_TOKEN ? await sha256(env.ADMIN_TOKEN) : '';
    directoryCache.clear();
    directoryCache.set(cacheKey, rbac.parseOperators(env.OPERATORS || '', adminHash));
  }
  return directoryCache.get(cacheKey);
}

function authConfig(env) {
  return { openReads: env.AUTH_OPEN_READS !== '0' };
}

async function authStatus(env) {
  const config = authConfig(env);
  let count = 0;
  try { count = (await operatorDirectory(env)).length; } catch { count = 0; }
  return {
    mode: count ? 'TOKEN' : config.openReads ? 'DEMO-READ-ONLY' : 'LOCKED',
    tokenConfigured: Boolean(env.ADMIN_TOKEN),
    operatorsConfigured: count,
    openReads: config.openReads,
    writesRequireToken: true,
  };
}

/** Returns { operator } on success or { response } to send back. */
async function authenticate(request, env, pathname, getAcl) {
  const perm = rbac.requiredPermission(request.method, pathname);
  if (perm === rbac.PUBLIC) return { operator: null };
  const config = authConfig(env);
  const directory = await operatorDirectory(env);
  const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);

  if (!match) {
    if (config.openReads && rbac.hasPermission(null, rbac.ANONYMOUS, perm)) return { operator: rbac.ANONYMOUS };
    if (!directory.length) {
      const read = request.method === 'GET' || request.method === 'HEAD';
      return { response: json({
        ok: false,
        error: read
          ? 'API access is disabled until ADMIN_TOKEN or OPERATORS is configured.'
          : 'Writes are disabled until ADMIN_TOKEN or OPERATORS is configured.',
      }, 503) };
    }
    return { response: json({ ok: false, error: 'unauthorized' }, 401) };
  }

  const address = request.headers.get('cf-connecting-ip') || 'unknown';
  const previous = failedLogins.get(address);
  if (previous && Date.now() > previous.resetAt) failedLogins.delete(address);
  const operator = rbac.findOperator(directory, await sha256(match[1].trim()));
  if (!operator) {
    const entry = failedLogins.get(address);
    if (!entry) failedLogins.set(address, { count: 1, resetAt: Date.now() + RATE_WINDOW_MS });
    else entry.count++;
    if (failedLogins.get(address).count >= RATE_LIMIT) {
      return { response: json({ ok: false, error: 'too many failed auth attempts, try later' }, 429) };
    }
    return { response: json({ ok: false, error: 'unauthorized' }, 401) };
  }
  failedLogins.delete(address);
  const roleDb = operator.role === 'r_owner' ? {} : await getAcl(); // custom roles live in D1
  if (!rbac.hasPermission(roleDb, operator, perm)) {
    return { response: json({ ok: false, error: 'forbidden', required: perm }, 403) };
  }
  return { operator };
}

function forbiddenSite(lockId) {
  return json({ ok: false, error: 'forbidden', required: 'site scope', detail: `lock ${lockId} is outside your sites` }, 403);
}

async function state(db, key, defaults) {
  const row = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first();
  if (row) return JSON.parse(row.value);
  const value = JSON.stringify(defaults);
  await db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
    .bind(key, value).run();
  const seeded = await db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first();
  return JSON.parse(seeded.value);
}

function stateStatement(db, key, value) {
  return db.prepare(
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, JSON.stringify(value));
}

async function saveState(db, key, value) {
  await stateStatement(db, key, value).run();
}

const rowToEntry = row => ({
  seq: row.seq, id: row.id, ts: row.ts, actor: row.actor, action: row.action,
  detail: row.detail, prevHash: row.prev_hash, hash: row.hash,
});

async function auditHead(db) {
  const row = await db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').first();
  return row ? { seq: row.seq, hash: row.hash } : { seq: 0, hash: auditCore.GENESIS };
}

/**
 * Seal queued audit entries into audit_log and persist ACL state in ONE
 * D1 batch (a transaction): either both land or neither does. Two
 * concurrent writers computing the same seq collide on the primary key,
 * so the chain can never fork silently.
 */
async function saveAcl(db, acl) {
  const head = await auditHead(db);
  const queue = [];
  if (Array.isArray(acl.auditLog)) {
    if (head.seq === 0) queue.push(...auditCore.fromLegacy(acl.auditLog));
    delete acl.auditLog;
  }
  if (acl.auditPending && acl.auditPending.length) queue.push(...acl.auditPending.splice(0));
  const sealed = auditCore.seal(head, queue);
  const insert = db.prepare(
    'INSERT INTO audit_log (seq, id, ts, actor, action, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  await db.batch([
    ...sealed.map(e => insert.bind(e.seq, e.id, e.ts, e.actor, e.action, e.detail, e.prevHash, e.hash)),
    stateStatement(db, 'acl', acl),
  ]);
}

async function readBody(request) {
  try {
    const text = await request.text();
    return text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    if (error instanceof SyntaxError) return { __invalidJson: true };
    throw error;
  }
}

function filterMirrorRecords(records, params) {
  let result = records;
  const lockId = params.get('lockId');
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  const limitParam = Number(params.get('limit'));
  if (lockId) result = result.filter(record => String(record.lockId) === lockId);
  if (from) result = result.filter(record => (record.at || 0) >= from);
  if (to) result = result.filter(record => (record.at || 0) <= to);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 500;
  return result.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

function mirrorCoverage(db) {
  const cutoff = Date.now() - 180 * 864e5;
  const beyond = db.records.filter(record => (record.at || 0) < cutoff);
  return {
    total: db.records.length,
    beyondVendorRetention: beyond.length,
    vendorRetentionDays: 180,
    vendorRetentionSource: 'TTLock Open Platform docs: "云端只保留半年内的操作记录"',
    lastSync: db.lastSync,
    note: beyond.length
      ? `${beyond.length} records exist only in your mirror — the vendor cloud has dropped them.`
      : 'No records older than the vendor retention window yet. Value accrues over time.',
  };
}

function demoRecords(lockId) {
  const types = [1, 4, 7, 8, 12, 55];
  const people = ['Sarah Kelly', 'Dev Patel', 'CleanCo Ltd', 'Tom Nguyen'];
  return Array.from({ length: 25 }, (_, index) => {
    const recordType = types[index % types.length];
    return {
      recordId: 1e6 + index,
      lockId,
      recordType,
      typeLabel: RECORD_TYPES[recordType],
      success: index % 11 === 0 ? 0 : 1,
      username: people[index % people.length],
      lockDate: Date.now() - index * 3.4e6,
    };
  });
}

function aiTools(db, doors) {
  return {
    whoCanOpen(name) {
      const door = doors.find(item => (item.lockAlias || '').toLowerCase().includes(name));
      if (!door) return null;
      const people = db.users
        .filter(user => policy.evaluate(db, user.id, door.lockId, new Date()).allowed)
        .map(user => user.name);
      return { door: door.lockAlias, people };
    },
    serviceVisits() {
      return {
        low: doors.filter(item => item.electricQuantity <= 30)
          .sort((a, b) => a.electricQuantity - b.electricQuantity),
        off: doors.filter(item => !item.hasGateway),
      };
    },
    anomalies() {
      return {
        denials: db.recentDenials || 0,
        suspended: db.users.filter(user => user.suspended),
        expiring: db.users.filter(user => user.validTo
          && new Date(user.validTo) < new Date(Date.now() + 30 * 864e5)),
      };
    },
    explainDenial(personName) {
      const user = db.users.find(item => item.name.toLowerCase().includes(personName));
      if (!user) return null;
      return {
        user: user.name,
        res: doors.map(door => {
          const timeZone = policy.siteTimeZone(db, (policy.siteForLock(db, door.lockId) || {}).id);
          const today = policy.localParts(new Date(), timeZone).isoDate;
          const at = policy.zonedTimeToDate(`${today}T21:00`, timeZone);
          return { door: door.lockAlias, r: policy.evaluate(db, user.id, door.lockId, at) };
        }),
      };
    },
  };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  if (method === 'GET' && pathname === '/api/auth') {
    return json({ ok: true, ...(await authStatus(env)) });
  }

  let aclPromise = null;
  const getAcl = () => {
    if (!env.DB) throw new Error('D1 binding DB is not configured.');
    if (!aclPromise) aclPromise = state(env.DB, 'acl', aclDefaults);
    return aclPromise;
  };

  let operator;
  try {
    const auth = await authenticate(request, env, pathname, getAcl);
    if (auth.response) return auth.response;
    operator = auth.operator;
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) }, 503);
  }
  const actor = operator ? operator.id : 'system';

  if (!env.DB) return json({ ok: false, error: 'D1 binding DB is not configured.' }, 503);

  try {
    const db = env.DB;
    const [acl, mirror] = await Promise.all([
      getAcl(),
      state(db, 'mirror', mirrorDefaults),
    ]);
    if (Array.isArray(acl.auditLog)) await saveAcl(db, acl); // one-time legacy migration
    const canLock = lockId => rbac.canAccessLock(acl, operator, lockId);
    const visibleLocks = DEMO_LOCKS.filter(lock => canLock(lock.lockId));

    if (method === 'POST' && pathname === '/api/auth/verify') {
      return json(ok({ authenticated: true, operator: rbac.describe(acl, operator) }));
    }
    if (method === 'GET' && pathname === '/api/me') {
      return json(ok({ operator: rbac.describe(acl, operator) }));
    }
    if (method === 'GET' && pathname === '/api/permissions') {
      return json(ok({ perms: rbac.PERMS, roles: acl.roles }));
    }

    if (method === 'GET' && pathname === '/api/status') {
      return json(ok({ mode: 'DEMO (Cloudflare demo; no physical lock operations)', region: 'demo' }));
    }

    if (method === 'GET' && pathname === '/api/doors') {
      const doors = visibleLocks.map(lock => {
        const group = acl.doorGroups.find(item => (item.lockIds || []).includes(lock.lockId));
        const site = group && acl.sites.find(item => item.id === group.siteId);
        return {
          ...lock,
          doorGroup: group ? group.name : null,
          site: site ? site.name : (lock.groupName || 'Unassigned'),
        };
      });
      return json(ok({ doors }));
    }

    const unlockMatch = pathname.match(/^\/api\/doors\/(\d+)\/unlock$/);
    if (method === 'POST' && unlockMatch) {
      const body = await readBody(request);
      if (body.__invalidJson) return json({ ok: false, error: 'invalid JSON body' }, 400);
      const lockId = Number(unlockMatch[1]);
      if (!canLock(lockId)) return forbiddenSite(lockId);
      const userId = body.userId;
      if (userId) {
        const decision = policy.evaluate(acl, userId, lockId, new Date());
        if (!decision.allowed) {
          policy.audit(acl, 'unlock.denied', `lock ${lockId} user ${userId}: ${decision.reason}`, actor);
          await saveAcl(db, acl);
          return json({ ok: false, denied: true, reason: decision.reason, path: decision.path }, 403);
        }
      }
      policy.audit(acl, 'unlock.granted', `lock ${lockId}${userId ? ` user ${userId}` : ' (operator override)'}`, actor);
      await saveAcl(db, acl);
      return json(ok({ unlocked: lockId, simulated: true }));
    }

    if (method === 'POST' && pathname === '/api/evaluate') {
      const body = await readBody(request);
      if (body.__invalidJson) return json({ ok: false, error: 'invalid JSON body' }, 400);
      const site = policy.siteForLock(acl, body.lockId);
      const timeZone = policy.siteTimeZone(acl, site && site.id);
      const at = body.localTime
        ? policy.zonedTimeToDate(body.localTime, timeZone)
        : body.when ? new Date(body.when) : new Date();
      if (Number.isNaN(at.getTime())) return json({ ok: false, error: 'invalid date' }, 400);
      return json(ok({
        at: at.toISOString(),
        site: site ? site.name : null,
        timeZone,
        localTime: policy.localParts(at, timeZone).label,
        result: policy.evaluate(acl, body.userId, Number(body.lockId), at),
      }));
    }

    const userDoorsMatch = pathname.match(/^\/api\/users\/([^/]+)\/doors$/);
    if (method === 'GET' && userDoorsMatch) {
      return json(ok({ doors: policy.doorsForUser(acl, decodeURIComponent(userDoorsMatch[1]), new Date()) }));
    }

    const collectionMatch = pathname.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/);
    if (collectionMatch && COLLECTIONS.has(collectionMatch[1])) {
      const [, collection, id] = collectionMatch;
      if (method === 'GET' && !id) return json(ok({ [collection]: acl[collection] }));
      if (method === 'POST' && !id) {
        const body = await readBody(request);
        if (body.__invalidJson) return json({ ok: false, error: 'invalid JSON body' }, 400);
        let clean;
        try { clean = validation.validate(collection, body, acl); }
        catch (error) {
          if (error instanceof validation.ValidationError) return json({ ok: false, error: error.message }, 400);
          throw error;
        }
        const item = { ...clean, id: policy.uid(collection.slice(0, 3)) };
        acl[collection].push(item);
        policy.audit(acl, `${collection}.create`, JSON.stringify(item).slice(0, 200), actor);
        await saveAcl(db, acl);
        return json(ok({ item }));
      }
      if (method === 'DELETE' && id) {
        const decodedId = decodeURIComponent(id);
        if (!acl[collection].some(item => item.id === decodedId)) return json({ ok: false, error: 'not found' }, 404);
        const refs = validation.referencedBy(collection, decodedId, acl);
        if (refs.length) return json({ ok: false, error: 'still referenced', referencedBy: refs.slice(0, 20) }, 409);
        acl[collection] = acl[collection].filter(item => item.id !== decodedId);
        policy.audit(acl, `${collection}.delete`, decodedId, actor);
        await saveAcl(db, acl);
        return json(ok());
      }
    }

    if (method === 'POST' && pathname === '/api/passcode') {
      const body = await readBody(request);
      if (body.__invalidJson) return json({ ok: false, error: 'invalid JSON body' }, 400);
      if (!canLock(body.lockId)) return forbiddenSite(body.lockId);
      const plan = creds.planPasscode(acl, {
        userId: body.userId, lockId: body.lockId, startAt: body.startAt, endAt: body.endAt,
        acknowledgeScheduleGap: body.acknowledgeScheduleGap === true,
      });
      if (!plan.ok) {
        policy.audit(acl, 'passcode.denied', `lock ${body.lockId} user ${body.userId}: ${plan.error}`, actor);
        await saveAcl(db, acl);
        const { ok: _ok, status, ...rest } = plan;
        return json({ ok: false, ...rest }, status);
      }
      const c = plan.credential;
      const passcode = {
        keyboardPwd: String(Math.floor(100000 + Math.random() * 899999)),
        keyboardPwdId: Date.now(),
      };
      const entry = creds.register(acl, c, { issuedBy: actor, vendorRef: passcode.keyboardPwdId, code: passcode.keyboardPwd });
      policy.audit(acl, 'passcode.create',
        `${entry.id} lock ${c.lockId} user ${body.userId} ${c.startAt}..${c.endAt} enforcement=${c.enforcement}`
        + (plan.warnings.length ? ` warnings: ${plan.warnings.join(' | ')}` : ''), actor);
      await saveAcl(db, acl);
      return json(ok({ passcode, credential: entry, warnings: plan.warnings }));
    }

    if (method === 'GET' && pathname === '/api/credentials') {
      const visible = (acl.credentials || []).filter(c => canLock(c.lockId));
      const ids = new Set(visible.map(c => c.id));
      return json(ok({ credentials: visible, review: creds.reviewCredentials(acl).filter(f => ids.has(f.id)) }));
    }

    const credMatch = pathname.match(/^\/api\/credentials\/([^/]+)$/);
    if (method === 'DELETE' && credMatch) {
      const id = decodeURIComponent(credMatch[1]);
      const cred = (acl.credentials || []).find(c => c.id === id);
      if (!cred) return json({ ok: false, error: 'not found' }, 404);
      if (!canLock(cred.lockId)) return forbiddenSite(cred.lockId);
      creds.revoke(acl, id, { revokedBy: actor, reason: 'manual' });
      policy.audit(acl, 'credential.revoke', `${id} lock ${cred.lockId} user ${cred.userId}`, actor);
      await saveAcl(db, acl);
      return json(ok({ credential: cred }));
    }

    const recordsMatch = pathname.match(/^\/api\/records\/(\d+)$/);
    if (method === 'GET' && recordsMatch) {
      if (!canLock(recordsMatch[1])) return forbiddenSite(recordsMatch[1]);
      return json(ok({ records: demoRecords(Number(recordsMatch[1])) }));
    }

    if (method === 'GET' && pathname === '/api/audit') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 1000);
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      const { results } = await db.prepare('SELECT * FROM audit_log WHERE seq < ? ORDER BY seq DESC LIMIT ?')
        .bind(before, limit).all();
      return json(ok({ log: results.map(rowToEntry) }));
    }

    if (method === 'GET' && pathname === '/api/audit/verify') {
      const { results } = await db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all();
      return json(ok({ verification: auditCore.verify(results.map(rowToEntry)) }));
    }

    if (method === 'GET' && pathname === '/api/vendor') {
      return json(ok({
        active: 'demo',
        available: ['demo'],
        capabilities: {
          listLocks: true, unlock: true, lock: true, passcodes: true,
          cards: false, fingerprints: false, records: true, recordsMaxDays: 3650,
          gateways: true, video: false, offlineLocal: true, webhooks: true,
        },
        health: { vendor: 'demo', ok: true, mode: 'DEMO', note: 'Simulated data. No physical lock operations.' },
      }));
    }

    if (method === 'POST' && pathname === '/api/mirror/sync') {
      return json({ ok: false, demo: true, error: 'TTLock sync is unavailable in the hosted demo.' }, 501);
    }

    if (method === 'GET' && pathname === '/api/mirror/coverage') {
      return json(ok(mirrorCoverage(mirror)));
    }

    if (method === 'GET' && pathname === '/api/mirror/records') {
      return json(ok({ records: filterMirrorRecords(mirror.records, url.searchParams) }));
    }

    if (method === 'GET' && pathname === '/api/health') {
      const lowBattery = visibleLocks.filter(door => door.electricQuantity <= 25);
      const offline = visibleLocks.filter(door => !door.hasGateway);
      return json(ok({
        total: visibleLocks.length,
        lowBattery,
        offline,
        score: Math.round(100 - (lowBattery.length * 12 + offline.length * 8)),
      }));
    }

    if (method === 'POST' && pathname === '/api/ai') {
      const body = await readBody(request);
      if (body.__invalidJson) return json({ ok: false, error: 'invalid JSON body' }, 400);
      const query = String(body.q || '').toLowerCase().slice(0, 1000);
      const denied = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'unlock.denied'").first();
      const tools = aiTools({ ...acl, recentDenials: denied ? denied.n : 0 }, visibleLocks);
      let answer;

      if (/batter|service|visit|maintenance|replace/.test(query)) {
        const { low, off } = tools.serviceVisits();
        answer = `<b>Suggested service run</b><br>`
          + (low.length ? low.map(door => `· <b>${h(door.lockAlias)}</b> — ${Number(door.electricQuantity)}% battery`
            + (door.electricQuantity <= 15 ? ' <span class="tag r">urgent</span>' : '')).join('<br>') : 'No low batteries.')
          + (off.length ? `<br>· <b>${off.map(door => h(door.lockAlias)).join(', ')}</b> — no gateway, cannot be opened remotely` : '')
          + '<br><br>Batching these into one visit saves a second call-out. Shall I draft the job sheet?';
      } else if (/unusual|anomal|risk|suspicious|odd|wrong/.test(query)) {
        const result = tools.anomalies();
        answer = `<b>Risk review</b><br>· ${result.denials} denied unlock attempt(s) recorded<br>`
          + `· ${result.suspended.length} suspended user(s): ${result.suspended.map(user => h(user.name)).join(', ') || 'none'}<br>`
          + `· ${result.expiring.length} credential(s) expiring within 30 days: ${result.expiring.map(user => h(user.name)).join(', ') || 'none'}`
          + '<br><br>Recommendation: remove suspended users from all groups so they disappear from reports, and renew expiring contractors before they lock themselves out.';
      } else if (/who can|who has|access to/.test(query)) {
        const match = query.match(/(server room|main entrance|warehouse|cleaner|gym front|gym staff|storage)/);
        const result = match ? tools.whoCanOpen(match[1]) : null;
        answer = result
          ? `<b>${h(result.door)}</b> — currently openable by: ${result.people.length ? result.people.map(h).join(', ') : '<i>nobody at this moment</i>'}.<br><br>This is evaluated live against schedules, so the answer changes with the clock.`
          : 'Name a door and I will list who can open it right now — e.g. "who can open the Server Room?"';
      } else if (/denied|why|refus|reject/.test(query)) {
        const match = query.match(/(sarah|dev|tom|cleanco|cleaner)/);
        const result = match ? tools.explainDenial(match[1]) : null;
        if (result) {
          const denied = result.res.filter(item => !item.r.allowed).slice(0, 4);
          answer = `<b>${h(result.user)}</b> at 21:00 (each site's local time):<br>${denied.map(item => `· ${h(item.door)}: ${h(item.r.reason)}`).join('<br>')}`
            + '<br><br>Most denials at that hour come from the <i>Office Hours</i> schedule ending 18:30. To change it, I can extend the window or add an evening exception — your approval required.';
        } else {
          answer = 'Tell me who was denied — e.g. "why was Sarah denied at 9pm?"';
        }
      } else if (/give|grant|add|allow|extend/.test(query)) {
        answer = '<b>Proposed change</b> (not yet applied)<br>I would add a rule: <b>Cleaning Contractor</b> → <b>Operations</b> on <b>Friday 18:00–21:00</b>.<br><br>Impact: 1 user group, 2 doors. No existing rule is removed.<br><i>Nothing is executed until you confirm.</i>';
      } else {
        answer = 'I can help with:<br>· <b>Diagnostics</b> — "which doors need a battery visit?"<br>'
          + '· <b>Explaining decisions</b> — "why was Sarah denied at 9pm?"<br>'
          + '· <b>Queries</b> — "who can open the Server Room?"<br>· <b>Risk review</b> — "anything unusual this week?"'
          + '<br>· <b>Rule drafting</b> — "give the cleaners Friday evening access"<br><br><i>Demo data only.</i>';
      }
      return json(ok({ answer }));
    }

    return json({ ok: false, error: 'not found' }, 404);
  } catch (error) {
    return json({ ok: false, error: String(error.message || error) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
