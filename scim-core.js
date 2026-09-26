/**
 * SCIM 2.0 server (RFC 7643 / 7644) — directory → door access.
 * ====================================================================
 * Entra ID, Okta and Google push people and groups here. The point is
 * the lifecycle: when HR/IT disables someone, their door credentials are
 * revoked by the reconciler within the same request.
 *
 * Design rules
 *  - The directory manages only what it created (or explicitly linked by
 *    email on first POST). Manually created door users are invisible here.
 *  - A SCIM group grants nothing until an owner maps it to a local user
 *    group. For directory-managed people, membership of a mapped user
 *    group is then recomputed from SCIM on every change (manually managed
 *    people in the same user group are left alone).
 *  - "Deactivated in the directory" is stored separately from an
 *    operator's suspension; neither can undo the other.
 *  - Data minimisation: we keep userName, externalId, a display name and
 *    one email. Everything else a directory sends is dropped.
 *  - Audit entries carry ids only (the audit chain is append-only).
 *  - All writes go through tenant.transact() (optimistic, no lost updates
 *    when a directory sends PATCHes in parallel).
 *
 * Known client quirks handled: capitalised ops ("Replace"), "False" as a
 * string, path-less replace with a value object, members[value eq "x"],
 * remove of members with a value array, excludedAttributes=members.
 */
const S = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
  spc: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  rt: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
  schema: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
};
const CONTENT_TYPE = 'application/scim+json';
const MAX_PAGE = 200;

class ScimError extends Error {
  constructor(status, detail, scimType) { super(detail); this.status = status; this.scimType = scimType; }
}
const errorBody = (status, detail, scimType) => ({ schemas: [S.error], status: String(status), ...(scimType ? { scimType } : {}), detail });
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function toBool(v, field) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true'; // Entra sends "False"
  throw new ScimError(400, `${field} must be a boolean`, 'invalidValue');
}
function str(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ScimError(400, `${field} is required`, 'invalidValue');
    return null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new ScimError(400, `${field} must be a string`, 'invalidValue');
  const s = String(v).trim();
  if (s.length > max) throw new ScimError(400, `${field} is too long (max ${max})`, 'invalidValue');
  return s || (required ? (() => { throw new ScimError(400, `${field} is required`, 'invalidValue'); })() : null);
}
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}$/;
function email(v) {
  const s = str(v, 'emails.value', 254);
  if (s && !EMAIL.test(s)) throw new ScimError(400, 'emails.value is not an email address', 'invalidValue');
  return s ? s.toLowerCase() : null;
}
const pickEmail = emails => {
  if (!Array.isArray(emails) || !emails.length) return null;
  const e = emails.find(x => x && x.primary === true) || emails.find(x => x && /work/i.test(x.type || '')) || emails[0];
  return e && e.value !== undefined ? email(e.value) : null;
};

/* ---------------- filters: attr eq "value" ---------------- */
function parseFilter(filter, allowed) {
  if (!filter) return null;
  const m = String(filter).match(/^\s*([A-Za-z][\w.:]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i);
  if (!m) throw new ScimError(400, 'only filters of the form: attribute eq "value" are supported', 'invalidFilter');
  const attr = m[1].replace(/^urn:ietf:params:scim:schemas:core:2\.0:(User|Group):/i, '').toLowerCase();
  if (!allowed[attr]) throw new ScimError(400, `filtering on ${m[1]} is not supported`, 'invalidFilter');
  const value = m[2].replace(/\\(.)/g, '$1');
  return item => allowed[attr](item, value);
}
const ci = (a, b) => a !== null && a !== undefined && String(a).toLowerCase() === String(b).toLowerCase();

/* ---------------- membership: directory groups → user groups ---------------- */
/**
 * For every directory-managed user: groupIds = (manual groups) ∪ (targets of mapped directory
 * groups the user belongs to). A user group that is the target of any
 * mapping is directory-controlled; `extraControlled` covers groups that
 * were controlled BEFORE this change (unmapping must remove access too).
 */
function membershipChanges(snap, extraControlled = []) {
  const controlled = new Set([...extraControlled, ...snap.directoryGroups.map(g => g.userGroupId).filter(Boolean)]);
  const changes = [];
  // Only directory-managed people: mapping a group must never silently strip
  // manually managed people (contractors, visitors) of their memberships.
  for (const u of snap.users.filter(x => x.source === 'scim')) {
    const fromDirectory = snap.directoryGroups.filter(g => g.userGroupId && (g.memberIds || []).includes(u.id)).map(g => g.userGroupId);
    const manual = (u.groupIds || []).filter(id => !controlled.has(id));
    const next = [...new Set([...manual, ...fromDirectory])];
    const prev = u.groupIds || [];
    if (next.length !== prev.length || next.some(id => !prev.includes(id))) {
      changes.push({ userId: u.id, groupIds: next, lost: prev.filter(id => !next.includes(id)) });
    }
  }
  return changes;
}

function createScim({ uid, reconcile = async () => {}, log = () => {} }) {
  /* ---------------- representations ---------------- */
  const userOut = (u, snap, base) => ({
    schemas: [S.user],
    id: u.id,
    ...(u.externalId ? { externalId: u.externalId } : {}),
    userName: u.userName,
    displayName: u.name,
    name: { formatted: u.name },
    emails: u.email ? [{ value: u.email, type: 'work', primary: true }] : [],
    active: u.directoryStatus !== 'inactive',
    groups: snap.directoryGroups.filter(g => (g.memberIds || []).includes(u.id)).map(g => ({ value: g.id, display: g.displayName, $ref: `${base}/Groups/${g.id}` })),
    meta: { resourceType: 'User', location: `${base}/Users/${u.id}` },
  });
  const groupOut = (g, snap, base, { members = true } = {}) => ({
    schemas: [S.group],
    id: g.id,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    displayName: g.displayName,
    ...(members ? {
      members: (g.memberIds || []).map(id => {
        const u = snap.users.find(x => x.id === id);
        return { value: id, display: u ? u.name : undefined, $ref: `${base}/Users/${id}` };
      }),
    } : {}),
    meta: { resourceType: 'Group', location: `${base}/Groups/${g.id}` },
  });
  const listOut = (items, query) => {
    const start = Math.max(1, parseInt(query.get('startIndex'), 10) || 1);
    const countRaw = query.get('count');
    const count = countRaw === null ? 100 : Math.min(Math.max(0, parseInt(countRaw, 10) || 0), MAX_PAGE);
    const page = items.slice(start - 1, start - 1 + count);
    return { schemas: [S.list], totalResults: items.length, startIndex: start, itemsPerPage: page.length, Resources: page };
  };

  const managedUsers = snap => snap.users.filter(u => u.source === 'scim');
  const findUser = (snap, id) => {
    const u = managedUsers(snap).find(x => x.id === id);
    if (!u) throw new ScimError(404, `User ${id} not found`);
    return u;
  };
  const findGroup = (snap, id) => {
    const g = snap.directoryGroups.find(x => x.id === id);
    if (!g) throw new ScimError(404, `Group ${id} not found`);
    return g;
  };

  /* ---------------- user model ---------------- */
  // Working model of the attributes we keep; PATCH/PUT edit it, then we write back.
  const modelOf = u => ({ userName: u.userName, externalId: u.externalId || null, displayName: u.name, formatted: null, givenName: null, familyName: null, email: u.email || null, active: u.directoryStatus !== 'inactive' });
  function readUser(body) {
    if (!isObj(body)) throw new ScimError(400, 'expected a JSON object', 'invalidSyntax');
    const n = isObj(body.name) ? body.name : {};
    return {
      userName: str(body.userName, 'userName', 254, { required: true }),
      externalId: str(body.externalId, 'externalId', 200),
      displayName: str(body.displayName, 'displayName', 100),
      formatted: str(n.formatted, 'name.formatted', 100),
      givenName: str(n.givenName, 'name.givenName', 100),
      familyName: str(n.familyName, 'name.familyName', 100),
      email: pickEmail(body.emails),
      active: body.active === undefined ? true : toBool(body.active, 'active'),
    };
  }
  const nameOf = m => (m.displayName || m.formatted || [m.givenName, m.familyName].filter(Boolean).join(' ') || m.userName).slice(0, 100);
  const emailOf = m => m.email || (EMAIL.test(m.userName || '') ? m.userName.toLowerCase() : null);

  function setUserAttr(m, rawPath, value, op) {
    const path = String(rawPath).replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/i, '');
    const p = path.toLowerCase();
    if (p.startsWith('urn:')) return; // extension schemas (enterprise manager, department…) — not stored
    const remove = op === 'remove';
    if (p === 'active') { if (!remove) m.active = toBool(value, 'active'); return; }
    if (p === 'username') { if (remove) throw new ScimError(400, 'userName cannot be removed', 'mutability'); m.userName = str(value, 'userName', 254, { required: true }); return; }
    if (p === 'externalid') { m.externalId = remove ? null : str(value, 'externalId', 200); return; }
    if (p === 'displayname') { m.displayName = remove ? null : str(value, 'displayName', 100); return; }
    if (p === 'name') {
      if (remove) { m.formatted = m.givenName = m.familyName = null; return; }
      if (!isObj(value)) throw new ScimError(400, 'name must be an object', 'invalidValue');
      for (const [k, v] of Object.entries(value)) setUserAttr(m, `name.${k}`, v, op);
      return;
    }
    if (p === 'name.formatted') { m.formatted = remove ? null : str(value, 'name.formatted', 100); return; }
    if (p === 'name.givenname') { m.givenName = remove ? null : str(value, 'name.givenName', 100); return; }
    if (p === 'name.familyname') { m.familyName = remove ? null : str(value, 'name.familyName', 100); return; }
    if (p === 'emails') { m.email = remove ? null : pickEmail(Array.isArray(value) ? value : [value]); return; }
    if (/^emails(\[.*\])?\.value$/.test(p)) { m.email = remove ? null : email(value); return; }
    // Anything else (phoneNumbers, title, addresses, locale…) is accepted and dropped.
  }

  function applyPatch(body, onOp) {
    if (!isObj(body) || !Array.isArray(body.Operations)) throw new ScimError(400, 'expected a PatchOp with Operations', 'invalidSyntax');
    if (body.Operations.length > 1000) throw new ScimError(400, 'too many operations', 'tooMany');
    for (const o of body.Operations) {
      const op = String((o && o.op) || '').toLowerCase(); // Entra: "Replace"
      if (!['add', 'replace', 'remove'].includes(op)) throw new ScimError(400, `unsupported op ${o && o.op}`, 'invalidValue');
      onOp(op, o.path ? String(o.path) : null, o.value);
    }
  }

  function userWrite(m) {
    return { userName: m.userName, externalId: m.externalId, name: nameOf(m), email: emailOf(m), directoryStatus: m.active ? 'active' : 'inactive' };
  }
  const userNameTaken = (snap, userName, exceptId) => snap.users.some(u => u.id !== exceptId && ci(u.userName, userName));

  /* ---------------- group members ---------------- */
  function memberIdsFrom(value, snap) {
    const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const ids = list.map(x => (isObj(x) ? x.value : x)).filter(v => v !== undefined && v !== null).map(String);
    const managed = new Set(managedUsers(snap).map(u => u.id));
    const unknown = ids.filter(id => !managed.has(id));
    if (unknown.length) throw new ScimError(400, `unknown member(s): ${unknown.slice(0, 5).join(', ')}`, 'invalidValue');
    return ids;
  }

  /* ---------------- handler ---------------- */
  async function handle({ t, tenantId, method, path, query, body, origin, actor }) {
    const base = `${origin}/scim/v2`;
    const ok = (status, out, headers) => ({ status, body: out, contentType: CONTENT_TYPE, headers });
    const sub = path.replace(/^\/scim\/v2/, '') || '/';
    let m;
    try {
      // ---- discovery ----
      if (method === 'GET' && sub === '/ServiceProviderConfig') return ok(200, serviceProviderConfig(base));
      if (method === 'GET' && sub === '/ResourceTypes') return ok(200, { schemas: [S.list], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: resourceTypes(base) });
      if (method === 'GET' && (m = sub.match(/^\/ResourceTypes\/(User|Group)$/))) return ok(200, resourceTypes(base).find(r => r.id === m[1]));
      if (method === 'GET' && sub === '/Schemas') return ok(200, { schemas: [S.list], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: schemaDefs() });
      if (method === 'GET' && (m = sub.match(/^\/Schemas\/(.+)$/))) {
        const found = schemaDefs().find(x => x.id === decodeURIComponent(m[1]));
        if (!found) throw new ScimError(404, 'schema not found');
        return ok(200, found);
      }

      // ---- Users ----
      if (sub === '/Users' && method === 'GET') {
        const snap = await t.snapshot();
        const match = parseFilter(query.get('filter'), {
          username: (u, v) => ci(u.userName, v), externalid: (u, v) => u.externalId === v, id: (u, v) => u.id === v,
          'emails.value': (u, v) => ci(u.email, v), emails: (u, v) => ci(u.email, v),
        });
        return ok(200, listOut(managedUsers(snap).filter(u => !match || match(u)).map(u => userOut(u, snap, base)), query));
      }
      if ((m = sub.match(/^\/Users\/([^/]+)$/)) && method === 'GET') {
        const snap = await t.snapshot();
        return ok(200, userOut(findUser(snap, m[1]), snap, base));
      }
      if (sub === '/Users' && method === 'POST') {
        const input = readUser(body);
        const result = await t.transact((snap, uow) => {
          if (managedUsers(snap).some(u => ci(u.userName, input.userName))) throw new ScimError(409, `userName ${input.userName} already exists`, 'uniqueness');
          const w = userWrite(input);
          // Adopt a manually created person with the same email instead of duplicating them.
          const existing = w.email && snap.users.find(u => u.source !== 'scim' && ci(u.email, w.email) && !u.userName);
          if (existing) {
            if (userNameTaken(snap, w.userName, existing.id)) throw new ScimError(409, `userName ${input.userName} already exists`, 'uniqueness');
            uow.update('users', existing.id, { ...w, source: 'scim' }).audit('scim.user_linked', existing.id, actor);
            return { id: existing.id, deactivated: !input.active };
          }
          if (userNameTaken(snap, w.userName)) throw new ScimError(409, `userName ${input.userName} already exists`, 'uniqueness');
          const id = uid('usr');
          uow.insert('users', { id, ...w, source: 'scim', groupIds: [], suspended: false }).audit('scim.user_create', id, actor);
          if (!input.active) uow.audit('scim.user_deactivate', id, actor);
          return { id, deactivated: !input.active };
        });
        if (result.deactivated) await reconcile(tenantId, result.id);
        const snap = await t.snapshot();
        const u = findUser(snap, result.id);
        return ok(201, userOut(u, snap, base), { Location: `${base}/Users/${u.id}` });
      }
      if ((m = sub.match(/^\/Users\/([^/]+)$/)) && (method === 'PUT' || method === 'PATCH')) {
        const id = m[1];
        const result = await t.transact((snap, uow) => {
          const u = findUser(snap, id);
          const before = modelOf(u);
          let next;
          if (method === 'PUT') next = readUser(body);
          else {
            next = { ...before };
            applyPatch(body, (op, path, value) => {
              if (!path) {
                if (op === 'remove') throw new ScimError(400, 'remove needs a path', 'noTarget');
                if (!isObj(value)) throw new ScimError(400, 'path-less operations need an object value', 'invalidValue');
                for (const [k, v] of Object.entries(value)) setUserAttr(next, k, v, op); // Entra: {"active": false}, {"name.givenName": "…"}
              } else setUserAttr(next, path, value, op);
            });
          }
          const w = userWrite(next);
          if (userNameTaken(snap, w.userName, id)) throw new ScimError(409, `userName ${w.userName} already exists`, 'uniqueness');
          const prev = userWrite(before);
          const changed = Object.keys(w).filter(k => (w[k] ?? null) !== (prev[k] ?? null));
          if (!changed.length) return { changed };
          uow.update('users', id, w);
          const other = changed.filter(k => k !== 'directoryStatus');
          if (other.length) uow.audit('scim.user_update', `${id} fields=${other.join(',')}`, actor);
          if (changed.includes('directoryStatus')) uow.audit(w.directoryStatus === 'inactive' ? 'scim.user_deactivate' : 'scim.user_reactivate', id, actor);
          return { changed, deactivated: changed.includes('directoryStatus') && w.directoryStatus === 'inactive' };
        });
        if (result.deactivated) await reconcile(tenantId, id);
        const snap = await t.snapshot();
        return ok(200, userOut(findUser(snap, id), snap, base));
      }
      if ((m = sub.match(/^\/Users\/([^/]+)$/)) && method === 'DELETE') {
        const id = m[1];
        await t.transact((snap, uow) => {
          findUser(snap, id);
          for (const g of snap.directoryGroups.filter(x => (x.memberIds || []).includes(id))) {
            uow.update('directoryGroups', g.id, { memberIds: g.memberIds.filter(x => x !== id) });
          }
          // Deleting the row is the erasure (audit references the id only).
          uow.remove('users', id).audit('scim.user_delete', `${id} (personal data erased)`, actor);
        });
        await reconcile(tenantId, id);
        return { status: 204, body: null };
      }

      // ---- Groups ----
      if (sub === '/Groups' && method === 'GET') {
        const snap = await t.snapshot();
        const match = parseFilter(query.get('filter'), {
          displayname: (g, v) => ci(g.displayName, v), externalid: (g, v) => g.externalId === v, id: (g, v) => g.id === v,
        });
        const members = !/(^|,)\s*members\s*(,|$)/i.test(query.get('excludedAttributes') || '');
        return ok(200, listOut(snap.directoryGroups.filter(g => !match || match(g)).map(g => groupOut(g, snap, base, { members })), query));
      }
      if ((m = sub.match(/^\/Groups\/([^/]+)$/)) && method === 'GET') {
        const snap = await t.snapshot();
        const members = !/(^|,)\s*members\s*(,|$)/i.test(query.get('excludedAttributes') || '');
        return ok(200, groupOut(findGroup(snap, m[1]), snap, base, { members }));
      }
      if (sub === '/Groups' && method === 'POST') {
        if (!isObj(body)) throw new ScimError(400, 'expected a JSON object', 'invalidSyntax');
        const id = await t.transact((snap, uow) => {
          const displayName = str(body.displayName, 'displayName', 200, { required: true });
          if (snap.directoryGroups.some(g => ci(g.displayName, displayName))) throw new ScimError(409, `group ${displayName} already exists`, 'uniqueness');
          const gid = uid('dgr');
          const memberIds = [...new Set(memberIdsFrom(body.members, snap))];
          uow.insert('directoryGroups', { id: gid, displayName, externalId: str(body.externalId, 'externalId', 200), memberIds, userGroupId: null })
            .audit('scim.group_create', `${gid} members=${memberIds.length}`, actor);
          return gid;
        });
        const snap = await t.snapshot();
        return ok(201, groupOut(findGroup(snap, id), snap, base), { Location: `${base}/Groups/${id}` });
      }
      if ((m = sub.match(/^\/Groups\/([^/]+)$/)) && (method === 'PUT' || method === 'PATCH')) {
        const id = m[1];
        const out = await t.transact((snap, uow) => {
          const g = findGroup(snap, id);
          const next = { displayName: g.displayName, externalId: g.externalId || null, memberIds: [...(g.memberIds || [])] };
          if (method === 'PUT') {
            if (!isObj(body)) throw new ScimError(400, 'expected a JSON object', 'invalidSyntax');
            next.displayName = str(body.displayName, 'displayName', 200, { required: true });
            next.externalId = str(body.externalId, 'externalId', 200);
            next.memberIds = memberIdsFrom(body.members, snap);
          } else {
            const setAttr = (op, key, value) => {
              const k = key.toLowerCase();
              if (k === 'displayname') { if (op === 'remove') throw new ScimError(400, 'displayName is required', 'mutability'); next.displayName = str(value, 'displayName', 200, { required: true }); }
              else if (k === 'externalid') next.externalId = op === 'remove' ? null : str(value, 'externalId', 200);
              else if (k === 'members') {
                if (op === 'replace') next.memberIds = memberIdsFrom(value, snap);
                else if (op === 'add') next.memberIds.push(...memberIdsFrom(value, snap));
                else if (value === undefined) next.memberIds = []; // remove all
                else {
                  const drop = new Set((Array.isArray(value) ? value : [value]).map(x => String(isObj(x) ? x.value : x)));
                  next.memberIds = next.memberIds.filter(x => !drop.has(x));
                }
              }
              // id / meta / unknown keys in a path-less value: ignored
            };
            applyPatch(body, (op, path, value) => {
              if (!path) {
                if (!isObj(value)) throw new ScimError(400, 'path-less operations need an object value', 'invalidValue');
                for (const [k, v] of Object.entries(value)) setAttr(op, k, v);
                return;
              }
              const filtered = path.match(/^members\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i); // Okta/Entra remove
              if (filtered) {
                if (op !== 'remove') throw new ScimError(400, 'filtered member paths are only supported for remove', 'invalidPath');
                const drop = filtered[1].replace(/\\(.)/g, '$1');
                next.memberIds = next.memberIds.filter(x => x !== drop);
                return;
              }
              const clean = path.replace(/^urn:ietf:params:scim:schemas:core:2\.0:Group:/i, '');
              if (!/^(displayName|externalId|members)$/i.test(clean)) throw new ScimError(400, `unsupported path ${path}`, 'invalidPath');
              setAttr(op, clean, value);
            });
          }
          next.memberIds = [...new Set(next.memberIds)];
          const prevMembers = new Set(g.memberIds || []);
          const added = next.memberIds.filter(x => !prevMembers.has(x));
          const removed = [...prevMembers].filter(x => !next.memberIds.includes(x));
          const renamed = next.displayName !== g.displayName || (next.externalId || null) !== (g.externalId || null);
          if (renamed && snap.directoryGroups.some(x => x.id !== id && ci(x.displayName, next.displayName))) throw new ScimError(409, `group ${next.displayName} already exists`, 'uniqueness');
          if (!added.length && !removed.length && !renamed) return { removed };
          uow.update('directoryGroups', id, next)
            .audit('scim.group_update', `${id}${added.length ? ` +${added.join(',')}` : ''}${removed.length ? ` -${removed.join(',')}` : ''}${renamed ? ' renamed' : ''}`, actor);
          // Push membership into door access (only matters if the group is mapped).
          const after = { ...snap, directoryGroups: snap.directoryGroups.map(x => (x.id === id ? { ...x, ...next } : x)) };
          for (const c of membershipChanges(after)) uow.update('users', c.userId, { groupIds: c.groupIds });
          return { removed: g.userGroupId ? removed : [] };
        });
        if (out.removed.length === 1) await reconcile(tenantId, out.removed[0]);
        else if (out.removed.length > 1) await reconcile(tenantId, null);
        const snap = await t.snapshot();
        return ok(200, groupOut(findGroup(snap, id), snap, base));
      }
      if ((m = sub.match(/^\/Groups\/([^/]+)$/)) && method === 'DELETE') {
        const id = m[1];
        const mapped = await t.transact((snap, uow) => {
          const g = findGroup(snap, id);
          uow.remove('directoryGroups', id).audit('scim.group_delete', id, actor);
          const after = { ...snap, directoryGroups: snap.directoryGroups.filter(x => x.id !== id) };
          for (const c of membershipChanges(after, g.userGroupId ? [g.userGroupId] : [])) uow.update('users', c.userId, { groupIds: c.groupIds });
          return Boolean(g.userGroupId);
        });
        if (mapped) await reconcile(tenantId, null);
        return { status: 204, body: null };
      }

      if (!/^\/(Users|Groups|ServiceProviderConfig|ResourceTypes|Schemas)(\/|$)/.test(sub)) throw new ScimError(404, `no SCIM endpoint ${sub}`);
      throw new ScimError(405, `${method} is not supported on ${sub}`);
    } catch (error) {
      if (error instanceof ScimError) return ok(error.status, errorBody(error.status, error.message, error.scimType));
      if (error && error.status === 409) return ok(409, errorBody(409, 'conflicting change, please retry'));
      if (error && /UNIQUE constraint/i.test(String(error.message))) return ok(409, errorBody(409, 'userName already exists', 'uniqueness'));
      log('scim error', error);
      return ok(500, errorBody(500, 'internal error'));
    }
  }

  return { handle };
}

/* ---------------- static discovery documents ---------------- */
function serviceProviderConfig(base) {
  return {
    schemas: [S.spc],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Operator token with the "Directory sync (SCIM)" role', primary: true }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  };
}
function resourceTypes(base) {
  return [
    { schemas: [S.rt], id: 'User', name: 'User', endpoint: '/Users', schema: S.user, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` } },
    { schemas: [S.rt], id: 'Group', name: 'Group', endpoint: '/Groups', schema: S.group, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` } },
  ];
}
const attr = (name, type, extra = {}) => ({ name, type, multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra });
function schemaDefs() {
  return [
    {
      schemas: [S.schema], id: S.user, name: 'User', description: 'Door user (only these attributes are stored)',
      attributes: [
        attr('userName', 'string', { required: true, uniqueness: 'server' }),
        attr('externalId', 'string', { caseExact: true }),
        attr('displayName', 'string'),
        attr('name', 'complex', { subAttributes: [attr('formatted', 'string'), attr('givenName', 'string'), attr('familyName', 'string')] }),
        attr('emails', 'complex', { multiValued: true, subAttributes: [attr('value', 'string'), attr('type', 'string'), attr('primary', 'boolean')] }),
        attr('active', 'boolean'),
        attr('groups', 'complex', { multiValued: true, mutability: 'readOnly', subAttributes: [attr('value', 'string'), attr('display', 'string')] }),
      ],
    },
    {
      schemas: [S.schema], id: S.group, name: 'Group', description: 'Directory group (grants access once mapped to a user group)',
      attributes: [
        attr('displayName', 'string', { required: true }),
        attr('externalId', 'string', { caseExact: true }),
        attr('members', 'complex', { multiValued: true, subAttributes: [attr('value', 'string'), attr('display', 'string')] }),
      ],
    },
  ];
}

module.exports = { createScim, membershipChanges, ScimError, errorBody, CONTENT_TYPE, parseFilter };
