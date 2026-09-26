#!/usr/bin/env node
// BOOTSTRAP ONLY: create an operator entry for the OPERATORS env var.
// Day-to-day, owners create operators in the app (POST /api/operators):
// those live in the database, are revocable instantly and audited.
//   npm run operator:new -- --id op_gym --name "Gym manager" --role r_manager --sites site_gym
// Prints the token ONCE (give it to the operator) and the JSON entry to
// append to OPERATORS. Only the SHA-256 is stored server-side.
const crypto = require('crypto');
const rbac = require('../rbac-core');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const role = opt('role', 'r_view');
if (!rbac.DEFAULT_ROLES.some(r => r.id === role)) {
  console.error(`Unknown role "${role}". Built-in roles: ${rbac.DEFAULT_ROLES.map(r => r.id).join(', ')}`);
  process.exit(1);
}
const token = crypto.randomBytes(24).toString('base64url');
const entry = {
  id: opt('id', `op_${crypto.randomBytes(3).toString('hex')}`),
  name: opt('name', 'New operator'),
  role,
  ...(opt('sites') ? { siteIds: opt('sites').split(',') } : {}),
  tokenSha256: crypto.createHash('sha256').update(token).digest('hex'),
};
console.log('Token (share securely, shown once):\n  ' + token);
console.log('\nOPERATORS entry:\n  ' + JSON.stringify(entry));
