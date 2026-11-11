#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos AI LLC
#
# Deploy to Cloudflare. The same four gates as scripts/deploy.sh, in the same
# order, for the same reason: on 1 September five failing tests reached
# production because nothing stood between the test run and the deploy.
#
#   npm run deploy:cf:staging     bash scripts/deploy-cf.sh staging
#   npm run deploy:cf             bash scripts/deploy-cf.sh production
#   npm run deploy:cf:force       bash scripts/deploy-cf.sh force      (incident only)
#
#   1. The working tree is clean and pushed.
#   2. CI is green for this commit.
#   3. Staging is running THIS commit — the Worker AND both containers.
#   4. The staging smoke test passes right now, against that build.
#
# And one gate that exists only because of the move: production is refused
# while any page still carries a CUTOVER-TODO marker, because those mark text
# that is not yet true (see docs/handoff/CUTOVER_CLOUDFLARE.md).
#
# Needs in the environment (values are never printed):
#   RATCHET_CF_STAGING_URL       e.g. https://ratchet-gate-staging.<subdomain>.workers.dev
#   RATCHET_OPS_TOKEN_STAGING    the staging Worker's OPS_TOKEN secret
#   RATCHET_OPS_TOKEN            the production Worker's OPS_TOKEN secret
#   PRECUTOVER=1                 production only: deploy WITHOUT attaching
#                                ratchetgate.com, and verify on RATCHET_CF_PROD_URL
#
# Docker must be running: Wrangler builds the image locally and pushes it.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=${1:-}
DOMAINS=(ratchetgate.com www.ratchetgate.com)

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

refuse() {
  echo
  red "REFUSING TO DEPLOY: $1"
  [ $# -gt 1 ] && echo "  $2"
  echo
  [ "$MODE" = "production" ] && echo "  If this is an incident and you accept the risk:  npm run deploy:cf:force"
  exit 1
}

case "$MODE" in staging|production|force) ;; *)
  echo "usage: deploy-cf.sh staging|production|force"; exit 2 ;;
esac

HEAD_SHA=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short HEAD)

command -v docker >/dev/null && docker info >/dev/null 2>&1 \
  || refuse "Docker is not running" "Wrangler builds the container image locally before it can deploy."
[ -d cloudflare/node_modules ] || refuse "cloudflare/node_modules is missing" "Run: npm --prefix cloudflare ci"

wrangler_deploy() {  # $1 = wrangler env ("" is production), rest = extra flags
  local env="$1"; shift
  ( cd cloudflare && npx wrangler deploy --env="$env" \
      --tag "$SHORT" --message "$HEAD_SHA" --var "GIT_COMMIT:$HEAD_SHA" "$@" )
}

# ── staging ─────────────────────────────────────────────────────────────────
if [ "$MODE" = "staging" ]; then
  if grep -q '<subdomain>' cloudflare/wrangler.toml; then
    refuse "cloudflare/wrangler.toml still has the <subdomain> placeholder" \
      "Staging's PUBLIC_URL is its OAuth issuer; it has to be the real workers.dev URL."
  fi
  : "${RATCHET_CF_STAGING_URL:?set RATCHET_CF_STAGING_URL to the staging workers.dev URL}"
  step "Deploying $SHORT to staging"
  wrangler_deploy staging
  step "Waiting for both containers to be running $SHORT"
  # The Worker is live at once. The containers are replaced by their Durable
  # Objects: on the next request for the API, and within a minute by alarm or
  # cron for the worker. Asking for a page starts the API straight away.
  curl -s -o /dev/null --max-time 30 "$RATCHET_CF_STAGING_URL/healthz" || true
  RATCHET_OPS_TOKEN="${RATCHET_OPS_TOKEN_STAGING:?set RATCHET_OPS_TOKEN_STAGING}" \
    node scripts/cf-status.mjs "$RATCHET_CF_STAGING_URL" "$HEAD_SHA" --wait=300 \
    || { red "Staging did not come up on $SHORT."; exit 1; }
  green "Staging is on $SHORT. Next: npm run deploy:cf"
  exit 0
fi

# ── force ───────────────────────────────────────────────────────────────────
if [ "$MODE" = "force" ]; then
  red "FORCED DEPLOY of $SHORT to production: no gate was checked."
  red "Not clean-tree, not CI, not staging, not the smoke test."
  if [ "${PRECUTOVER:-}" = "1" ]; then wrangler_deploy ""; else wrangler_deploy "" --domain "${DOMAINS[0]}" --domain "${DOMAINS[1]}"; fi
  exit 0
fi

# ── production ──────────────────────────────────────────────────────────────
: "${RATCHET_CF_STAGING_URL:?set RATCHET_CF_STAGING_URL to the staging workers.dev URL}"
: "${RATCHET_OPS_TOKEN_STAGING:?set RATCHET_OPS_TOKEN_STAGING}"
: "${RATCHET_OPS_TOKEN:?set RATCHET_OPS_TOKEN}"

step "0/4  Does every page say only what is true after this deploy?"
if grep -rl 'CUTOVER-TODO' web >/dev/null 2>&1; then
  refuse "pages still carry CUTOVER-TODO markers" \
    "$(grep -rl 'CUTOVER-TODO' web | tr '\n' ' ') — see docs/handoff/CUTOVER_CLOUDFLARE.md §2."
fi
green "      no unresolved markers"

step "1/4  Is this build reproducible?"
if [ -n "$(git status --porcelain)" ]; then
  refuse "the working tree has uncommitted changes" \
    "Whatever is live must be something you can check out again. Commit or stash."
fi
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if ! git merge-base --is-ancestor "$HEAD_SHA" "origin/$BRANCH" 2>/dev/null; then
  refuse "this commit is not pushed to origin/$BRANCH" \
    "Push first, so what is live exists somewhere other than this laptop."
fi
green "      clean tree, $SHORT pushed to origin/$BRANCH"

step "2/4  Is CI green for $SHORT?"
CI_STATUS=$(gh run list --workflow=ci.yml --commit "$HEAD_SHA" --limit 1 \
  --json conclusion --jq '.[0].conclusion // "none"' 2>/dev/null || echo "unknown")
case "$CI_STATUS" in
  success) green "      CI passed" ;;
  none)    refuse "CI has not run for $SHORT" "Wait for it, or push again." ;;
  unknown) refuse "could not reach GitHub to check CI" "Check your gh auth." ;;
  *)       refuse "CI concluded '$CI_STATUS' for $SHORT" ;;
esac

step "3/4  Is staging running $SHORT — the Worker and both containers?"
curl -s -o /dev/null --max-time 30 "$RATCHET_CF_STAGING_URL/healthz" || true
if ! RATCHET_OPS_TOKEN="$RATCHET_OPS_TOKEN_STAGING" \
     node scripts/cf-status.mjs "$RATCHET_CF_STAGING_URL" "$HEAD_SHA" --wait=90; then
  refuse "staging is not running $SHORT" "Deploy it first:  npm run deploy:cf:staging"
fi
green "      staging is on $SHORT"

step "4/4  Does that build pass its smoke test?"
if ! BASE="$RATCHET_CF_STAGING_URL" node scripts/smoke.mjs; then
  refuse "the staging smoke test failed" \
    "That is the same build you were about to put in front of customers."
fi

step "Deploying $SHORT to production"
if [ "${PRECUTOVER:-}" = "1" ]; then
  : "${RATCHET_CF_PROD_URL:?PRECUTOVER=1 needs RATCHET_CF_PROD_URL (the production workers.dev URL)}"
  VERIFY_URL="$RATCHET_CF_PROD_URL"
  echo "      PRECUTOVER=1: ratchetgate.com is NOT being attached."
  wrangler_deploy ""
else
  VERIFY_URL="https://ratchetgate.com"
  wrangler_deploy "" --domain "${DOMAINS[0]}" --domain "${DOMAINS[1]}"
fi

step "Verifying production at $VERIFY_URL"
# The API container is replaced on the first request after the deploy, and
# answers 503 (closed) while it restarts. Wait for it instead of reading the
# first answer.
curl -s -o /dev/null --max-time 30 "$VERIFY_URL/healthz" || true
if ! node scripts/cf-status.mjs "$VERIFY_URL" "$HEAD_SHA" --wait=300; then
  red "Production did not come up on $SHORT. It is answering 503 (closed) or the old build."
  echo "  Roll FORWARD: fix, push, and run the gates again. If the previous commit"
  echo "  was good, check it out and run:  npm run deploy:cf:force"
  exit 1
fi
for path in /healthz /readyz /workerz; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$VERIFY_URL$path")
  if [ "$code" = "200" ]; then green "      $path  $code"; else
    red "      $path  $code"
    red "Production is answering badly after the deploy. Roll forward (see above)."
    exit 1
  fi
done

echo
green "Deployed $SHORT."
