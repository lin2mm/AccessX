const fs = require('fs');
const path = require('path');
const policy = require('./policy-core');
const auditCore = require('./audit-core');
const { createAuditStore } = require('./audit-store');

// data/acl.json is the tracked seed. Runtime state lives in DATA_DIR
// (default data/runtime/, git-ignored) so running the server never
// rewrites files under version control.
const SEED = path.join(__dirname, 'data', 'acl.json');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data', 'runtime');
const DB = path.join(DATA_DIR, 'acl.json');
const auditStore = createAuditStore(DATA_DIR);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function load() {
  const data = readJson(DB) || readJson(SEED) || JSON.parse(JSON.stringify(policy.BLANK));
  for (const key of Object.keys(policy.BLANK)) if (!Array.isArray(data[key])) data[key] = [];
  return data;
}

function save(data) {
  // 1) Audit first (write-ahead): never persist a change that isn't on record.
  const queue = [];
  if (Array.isArray(data.auditLog)) {
    if (auditStore.isEmpty()) queue.push(...auditCore.fromLegacy(data.auditLog));
    delete data.auditLog; // legacy in-state log is retired
  }
  if (data.auditPending && data.auditPending.length) queue.push(...data.auditPending.splice(0));
  auditStore.append(queue);

  // 2) Then state.
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  const tmp = `${DB}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB); // atomic replace: a crash never leaves half a file
}

module.exports = { ...policy, load, save, DATA_DIR, auditStore };
