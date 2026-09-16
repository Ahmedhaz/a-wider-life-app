#!/usr/bin/env bash
# The one ship path. Tests, bundle, deploy, then close by an external result: the live build marker must
# match, and health must answer. A green CI is not a deploy; a matching marker on the live URL is.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_NAME="${1:-dev}"            # dev | staging | prod
BASE_URL="${AWL_BASE_URL:-https://a-wider-life.ahmed-haz.workers.dev}"
MARK="ship-$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"

echo "== tests"
(cd "$ROOT/worker" && npx vitest run --reporter=dot)
(cd "$ROOT/worker" && npx tsc --noEmit)
node "$ROOT/content/validate.mjs"

echo "== bundle · $MARK"
(cd "$ROOT/worker" && npx wrangler deploy --dry-run --outdir dist --var BUILD:"$MARK" >/dev/null)

echo "== deploy ($ENV_NAME)"
(cd "$ROOT/worker" && npx wrangler deploy --var BUILD:"$MARK")

echo "== close by result"
LIVE="$(curl -sS --max-time 15 "$BASE_URL/__build" || true)"
if [ "$LIVE" != "$MARK" ]; then echo "LIVE MARKER '$LIVE' != '$MARK' · deploy NOT closed"; exit 2; fi
curl -sS --max-time 15 "$BASE_URL/v1/health" | tee /dev/stderr | grep -q '"ok":true' || { echo "health failed"; exit 3; }
echo "closed · $MARK live at $BASE_URL"
