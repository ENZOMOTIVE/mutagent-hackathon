#!/usr/bin/env bash
# =============================================================================
# install-hooks.sh — mutagent-diagnostics skill-local git hook installer
# =============================================================================
# Installs the skill's pre-push hook into the shared .git/hooks (works from a
# worktree via --git-common-dir). Idempotent. Standalone usage from the skill
# package root:  bun run setup:hooks
#
# Scope discipline: this installer belongs to the mutagent-diagnostics package
# and ONLY installs the diagnostics pre-push hook. It does NOT touch the
# monorepo-root scripts/install-hooks.sh (which manages pre-commit/post-commit/
# post-checkout). If a root pre-push hook is later added, this installer should
# be folded into it; until then it is self-contained per feedback_infra_changes_last.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GIT_COMMON="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [ -z "$GIT_COMMON" ]; then
  echo "[mdiag install-hooks] not inside a git repo — skipping" >&2
  exit 0
fi
HOOKS_DIR="$GIT_COMMON/hooks"
mkdir -p "$HOOKS_DIR"

SRC="$SCRIPT_DIR/pre-push.sh"
DST="$HOOKS_DIR/pre-push"

if [ ! -f "$SRC" ]; then
  echo "[mdiag install-hooks] source hook missing: $SRC" >&2
  exit 1
fi

# Guard: if a DIFFERENT pre-push hook already exists (not ours), do not clobber.
if [ -f "$DST" ] && ! grep -q "mdiag pre-push" "$DST" 2>/dev/null; then
  echo "[mdiag install-hooks] a non-diagnostics pre-push hook already exists at $DST" >&2
  echo "[mdiag install-hooks] NOT overwriting — integrate the diagnostics T2 manually:" >&2
  echo "[mdiag install-hooks]   bash $SRC" >&2
  exit 0
fi

cp "$SRC" "$DST"
chmod +x "$DST"
echo "[mdiag install-hooks] pre-push hook installed → $DST"
