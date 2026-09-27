#!/usr/bin/env bash
# Worker smoke test on a brand-new local D1 and a freshly started wrangler (docs/92-AUTONOMY.md).
# Several checks only mean something on a cold instance (the R20 concurrency bug), so never reuse one.
#   bash support/smoke-fresh.sh            # exit code = smoke result
# Needs .dev.vars (node support/dev-vars.js). Uses /tmp/d1state and port 8787; stops its wrangler.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f .dev.vars ] || node support/dev-vars.js
if ss -ltn | grep -q ':8787 '; then echo "port 8787 is busy: stop the other wrangler first"; exit 2; fi
rm -rf /tmp/d1state
npx wrangler d1 migrations apply DB --local --persist-to /tmp/d1state > /tmp/smoke-migrate.log 2>&1 || { echo "migrations failed: /tmp/smoke-migrate.log"; exit 2; }
# Own process group (setsid), so npx, wrangler and workerd all stop together at exit.
setsid npx wrangler dev --local --persist-to /tmp/d1state --port 8787 --ip 127.0.0.1 > /tmp/wrangler.log 2>&1 &
WR=$!
trap 'kill -TERM -- -$WR 2>/dev/null; sleep 1; kill -KILL -- -$WR 2>/dev/null; true' EXIT
for _ in $(seq 1 60); do ss -ltn | grep -q ':8787 ' && break; sleep 1; done
ss -ltn | grep -q ':8787 ' || { echo "wrangler did not start: /tmp/wrangler.log"; exit 2; }
sleep 3
NUKI_PORT=4002 CALENDAR_SECRET=cal-smoke-secret-0123456789abcdef WRANGLER_LOG=/tmp/wrangler.log MAIL_PORT=8799 \
  OWNER=owner-token GYM=gym-token AUDIT=audit-token PLATFORM=platform-token npm run -s test:worker
