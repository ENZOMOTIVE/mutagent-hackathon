#!/usr/bin/env bash
# scripts/cli/run.sh — bun -> pnpm-tsx -> npx-tsx fallback selector + .sh dispatch.
# Usage: scripts/cli/run.sh <script-path.{ts|sh}> [args...]
#        scripts/cli/run.sh --selftest
#
# All engine invocations go through this wrapper so the package stays portable
# across bun/pnpm/npm hosts with zero Bun.* API dependence.
#
# Platform matrix — which tier fires when:
#   Tier 1 (bun)      : bun is on PATH
#   Tier 2 (pnpm-tsx) : bun absent, pnpm on PATH
#   Tier 3 (npx-tsx)  : bun + pnpm absent, npx on PATH
#   Tier 4 (error)    : none of the above — exits 1 with install guidance

set -e

SCRIPT="$1"

if [ "$SCRIPT" = "--selftest" ]; then
  if command -v bun >/dev/null 2>&1; then
    echo "run.sh selftest: tier=1 runtime=bun version=$(bun --version 2>/dev/null || echo unknown)"
  elif command -v pnpm >/dev/null 2>&1; then
    echo "run.sh selftest: tier=2 runtime=pnpm-tsx version=$(pnpm --version 2>/dev/null || echo unknown)"
  elif command -v npx >/dev/null 2>&1; then
    echo "run.sh selftest: tier=3 runtime=npx-tsx version=$(node --version 2>/dev/null || echo unknown)"
  else
    echo "run.sh selftest: tier=4 runtime=none (install bun: curl -fsSL https://bun.sh/install | bash)"
    exit 1
  fi
  exit 0
fi

shift || true

if [ -z "$SCRIPT" ]; then
  echo "ERROR: no script path provided" >&2
  echo "Usage: run.sh <script.{ts|sh}> [args...]" >&2
  echo "       run.sh --selftest" >&2
  exit 1
fi

case "$SCRIPT" in
  *.sh) exec bash "$SCRIPT" "$@" ;;
esac

if command -v bun >/dev/null 2>&1; then
  exec bun run "$SCRIPT" "$@"
elif command -v pnpm >/dev/null 2>&1; then
  exec pnpm exec tsx "$SCRIPT" "$@"
elif command -v npx >/dev/null 2>&1; then
  exec npx tsx "$SCRIPT" "$@"
else
  echo "ERROR: mutagent-evaluator requires bun, pnpm, or npm/npx to run TypeScript scripts" >&2
  echo "Install bun: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
