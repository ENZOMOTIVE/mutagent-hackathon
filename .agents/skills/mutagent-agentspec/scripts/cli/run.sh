#!/usr/bin/env bash
# scripts/cli/run.sh — bun→pnpm→npm fallback selector + .sh dispatch.
# Usage: scripts/cli/run.sh <script-path.{ts|sh}> [args...]
#        scripts/cli/run.sh --selftest
#
# This wrapper provides consistent script invocation across operator environments.
# All agent Bash() calls to TypeScript OR shell scripts MUST go through this wrapper:
#   Bash("scripts/cli/run.sh scripts/validate/validate-spec.ts ...")
#
# Platform matrix — which tier fires when:
#   Tier 1 (bun)      : bun is on PATH (local dev, most operator installs)
#   Tier 2 (pnpm-tsx) : bun absent, pnpm on PATH (corporate Node setups, pnpm-only CIs)
#   Tier 3 (npx-tsx)  : bun + pnpm absent, npx on PATH (vanilla Node, GitHub Actions default)
#   Tier 4 (error)    : none of the above — exits 1 with install guidance
# .sh scripts bypass all tiers and run directly via bash regardless of PATH state.

set -e

SCRIPT="$1"

# --selftest: print selected runtime and exit 0 (portability probe)
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

shift

if [ -z "$SCRIPT" ]; then
  echo "ERROR: no script path provided" >&2
  echo "Usage: run.sh <script.{ts|sh}> [args...]" >&2
  echo "       run.sh --selftest" >&2
  exit 1
fi

# .sh files: execute directly via bash (no TS runtime needed)
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
  echo "ERROR: mutagent-agentspec requires bun, pnpm, or npm/npx to run TypeScript scripts" >&2
  echo "Install bun: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
