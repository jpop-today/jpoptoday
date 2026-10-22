#!/usr/bin/env bash
# One-command production release for the maintainer's machine.
# Cloudflare credentials live outside the repo (default ~/.jpoptoday-cf.env, chmod 600),
# so nothing secret is ever typed into a terminal history, chat, or commit.
set -euo pipefail

env_file="${JPOP_CF_ENV:-$HOME/.jpoptoday-cf.env}"
if [ ! -f "$env_file" ]; then
  echo "Missing $env_file (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)." >&2
  exit 1
fi
mode=$(stat -f %Lp "$env_file" 2>/dev/null || stat -c %a "$env_file")
if [ "${mode: -2}" != "00" ]; then
  echo "$env_file is readable by others; run: chmod 600 $env_file" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a
: "${CLOUDFLARE_API_TOKEN:?not set in $env_file}" "${CLOUDFLARE_ACCOUNT_ID:?not set in $env_file}"

cd "$(dirname "$0")/.."
git checkout main
git pull --ff-only origin main
sha=$(git rev-parse HEAD)
echo "Releasing main $(git rev-parse --short HEAD)"

JPOP_BUILD_TARGET=production npm run build
npm run verify:dist
npm run deploy:production
EXPECTED_TARGET=production EXPECTED_SOURCE_SHA="$sha" npm run verify:deployment -- \
  https://jpop.today dist "../production-check-$(date +%Y%m%d-%H%M%S).json"
