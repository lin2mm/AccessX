#!/usr/bin/env bash
# Bring the checkout back after a sandbox reset (docs/92-AUTONOMY.md §2).
# A reset restores the files but may put HEAD back at the base commit and drops
# node_modules, .dev.vars, /tmp and running processes. Pushed commits are safe.
#   bash support/agent-recover.sh
# Never discards work: `git reset --mixed` only moves HEAD and the index; the work tree stays.
set -euo pipefail
cd "$(dirname "$0")/.."
BR=$(git branch --show-current)
[ -n "$BR" ] || { echo "detached HEAD: stop and look"; exit 1; }
git fetch -q origin "+refs/heads/$BR:refs/remotes/origin/$BR"
HEAD_SHA=$(git rev-parse HEAD); ORIGIN_SHA=$(git rev-parse "origin/$BR")
if [ "$HEAD_SHA" = "$ORIGIN_SHA" ]; then
  echo "HEAD = origin/$BR ($(git log --oneline -1 | cut -c1-70))"
elif git merge-base --is-ancestor "$HEAD_SHA" "$ORIGIN_SHA"; then
  git reset -q --mixed "origin/$BR"
  echo "HEAD was behind (reset): moved to origin/$BR, work tree untouched"
elif git merge-base --is-ancestor "$ORIGIN_SHA" "$HEAD_SHA"; then
  echo "local commits not pushed yet: $(git rev-list --count "origin/$BR..HEAD") -> git push origin $BR"
else
  echo "HEAD and origin/$BR have diverged: stop and look (never force-push without a lease)"; exit 1
fi
CHANGED=$(git status --porcelain | wc -l)
echo "uncommitted paths: $CHANGED"; [ "$CHANGED" -eq 0 ] || git status --short | head -20
[ -d node_modules ] || npm ci --no-audit --no-fund --silent
[ -f .dev.vars ] || node support/dev-vars.js
echo "commits since base: $(git rev-list --count b74185b..HEAD)"
df -h . | awk 'NR==2{print "disk: "$4" free of "$2}'
du -sh .git node_modules 2>/dev/null | tr '\n' ' '; echo
