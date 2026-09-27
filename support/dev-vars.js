#!/usr/bin/env node
// Writes .dev.vars for `wrangler dev` with the fixed test tokens that support/worker-smoke.js
// expects (owner-token, gym-token, audit-token, platform-token). Local testing only: never
// use these values anywhere else. Refuses to overwrite an existing file unless --force.
//   node support/dev-vars.js [--force]
// Why a script (docs/92-AUTONOMY.md): .dev.vars is gitignored, so every sandbox reset loses it,
// and dotenv does not unescape \" inside double quotes, so a hand-written OPERATORS line breaks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const file = path.join(__dirname, '..', '.dev.vars');
if (fs.existsSync(file) && !process.argv.includes('--force')) {
  console.log('.dev.vars exists; keep it (use --force to replace)');
  process.exit(0);
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const operators = [
  { id: 'op_gym', name: 'Gym manager', role: 'r_manager', siteIds: ['site_gym'], tokenSha256: sha('gym-token') },
  { id: 'op_audit', name: 'Auditor', role: 'r_view', siteIds: [], tokenSha256: sha('audit-token') },
];
const vars = {
  ADMIN_TOKEN: 'owner-token',
  PLATFORM_TOKEN: 'platform-token',
  OPERATORS: JSON.stringify(operators),
  SECRETS_KEY: crypto.randomBytes(32).toString('base64'),
  PUBLIC_URL: 'http://127.0.0.1:8787',
  EMAIL_PROVIDER: 'resend',
  EMAIL_API_KEY: 're_local_test',
  EMAIL_FROM: 'AccessX <alerts@example.com>',
  EMAIL_API_BASE: 'http://127.0.0.1:8799', // worker-smoke's fake mail server (MAIL_PORT=8799)
  SIGNUP_ENABLED: '1',
  CALENDAR_INBOUND_DOMAIN: 'in.example.com',
  CALENDAR_INBOUND_SECRET: 'cal-smoke-secret-0123456789abcdef',
  NUKI_API_BASE: 'http://127.0.0.1:4002', // worker-smoke's fake Nuki cloud (NUKI_PORT=4002)
  USAGE_METER: '1',
};
// Single quotes: dotenv takes the content literally (JSON keeps its double quotes).
const body = Object.entries(vars).map(([k, v]) => {
  if (v.includes("'")) throw new Error(`${k} must not contain a single quote`);
  return `${k}='${v}'`;
}).join('\n') + '\n';
fs.writeFileSync(file, body, { mode: 0o600 });
console.log(`wrote ${path.relative(process.cwd(), file) || '.dev.vars'} (${Object.keys(vars).length} variables, test tokens only)`);
console.log('smoke: NUKI_PORT=4002 CALENDAR_SECRET=cal-smoke-secret-0123456789abcdef MAIL_PORT=8799 OWNER=owner-token GYM=gym-token AUDIT=audit-token PLATFORM=platform-token npm run -s test:worker');
