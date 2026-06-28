#!/usr/bin/env bash
# =============================================================================
# pre-push.sh — mutagent-diagnostics on-demand Langfuse integration gate (T2)
# =============================================================================
# Runs the T2 LIVE Langfuse integration (verify:langfuse) before a push, ONLY
# for contributors who have a local Langfuse stack + creds. It SKIPS LOUDLY and
# exits 0 when the stack/creds are absent (CI + keyless contributors stay green).
# This mirrors the repo's "on-demand local verification" pattern (see the
# Wave-5.1 coverage matrix spec).
#
# This hook is INTENTIONALLY skill-local (installed by `bun run setup:hooks`
# from THIS package) — it does NOT modify the monorepo-root install-hooks.sh.
# It is heavier than pre-commit, so it runs at push time, not on every commit.
#
# To enable for this clone:
#   cd mutagent-system/mutagent-diagnostics && bun run setup:hooks
# To bypass intentionally (e.g. offline): the hook self-skips when no stack —
# you should NOT need --no-verify. Never use --no-verify to hide a real failure.
# =============================================================================

set -euo pipefail

# This hook runs as the INSTALLED copy at .git/hooks/pre-push, so it cannot use
# its own location to find the package — it discovers the package via the git
# worktree toplevel. Works from the root checkout AND from any worktree.
TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$TOP" ]; then
  echo "[mdiag pre-push] not inside a git worktree — skipping" >&2
  exit 0
fi
PKG_DIR="$TOP/mutagent-system/mutagent-diagnostics"

if [ ! -f "$PKG_DIR/package.json" ]; then
  # The diagnostics package is not present in this worktree (e.g. a checkout that
  # predates the skill). Nothing to verify — skip cleanly.
  echo "[mdiag pre-push] diagnostics package not found at $PKG_DIR — skipping" >&2
  exit 0
fi

# Source local Langfuse creds if present. The hook never prints or commits keys.
# Absence is fine — verify:langfuse self-skips loudly. Prefer creds already in
# the environment; otherwise try the worktree's mutagent/.env (post-checkout hook
# copies it) then the root checkout's mutagent/.env.
if [ -z "${LANGFUSE_HOST:-}" ] || [ -z "${LANGFUSE_PUBLIC_KEY:-}" ] || [ -z "${LANGFUSE_SECRET_KEY:-}" ]; then
  GIT_COMMON="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  ROOT_CHECKOUT="$(cd "$GIT_COMMON/.." 2>/dev/null && pwd || true)"
  for envf in "$TOP/mutagent/.env" "$ROOT_CHECKOUT/mutagent/.env"; do
    if [ -f "$envf" ]; then
      set -a
      # shellcheck disable=SC1090
      source "$envf"
      set +a
      break
    fi
  done
fi

echo "[mdiag pre-push] running T2 Langfuse integration (verify:langfuse) …" >&2
if ! command -v bun >/dev/null 2>&1; then
  echo "[mdiag pre-push] bun not found — skipping T2 (install bun to enable)" >&2
  exit 0
fi

# Enter the package dir defensively. If the dir is inaccessible (e.g. a sandboxed
# / restricted worktree path), skip loudly rather than fail the push — an
# unreachable package is an ENVIRONMENT problem, not a test failure. This keeps
# the hook aligned with its "skip when you can't actually run" philosophy and
# never forces a --no-verify bypass.
if ! cd "$PKG_DIR" 2>/dev/null; then
  echo "[mdiag pre-push] cannot enter $PKG_DIR — skipping T2 (restricted/unavailable path)" >&2
  exit 0
fi
# Verify the package script exists before invoking (guards against partial checkouts).
if ! grep -q '"verify:langfuse"' package.json 2>/dev/null; then
  echo "[mdiag pre-push] verify:langfuse script not present here — skipping T2" >&2
  exit 0
fi
bun run verify:langfuse
