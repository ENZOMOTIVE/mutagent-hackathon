#!/usr/bin/env bash
# scripts/fetch/claude-code-transcripts.sh
# R-SELF-03-b: Fetch Claude Code local transcripts for a given time window.
#
# Wraps Claude Code's session JSONL discovery at:
#   ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
#
# Outputs: last-Nh-meta.json consumable by tier0-scan.ts
#
# Usage:
#   scripts/fetch/claude-code-transcripts.sh [--hours N] [--project-path PATH] [--output-dir DIR]
#
# Arguments:
#   --hours N          Look back N hours (default: 24)
#   --project-path P   Specific encoded project path under ~/.claude/projects/
#                      (default: auto-discover all projects)
#   --output-dir DIR   Write last-Nh-meta.json + raw JSONL here (default: /tmp/mutagent-fetch-$$)
#
# R-SELF-03-c compliance: uses published scripts, does NOT inline Python heredocs.
# R-002-A-v2: inline bun eval + python3 heredoc replaced with assemble-meta.ts helper.

set -euo pipefail

# Skill root: two levels up from this script (scripts/fetch/ → scripts/ → skill root).
# Works with both absolute and relative $0 paths (cd resolves both).
SKILL_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

HOURS=24
PROJECT_PATH=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours)      HOURS="$2";        shift 2 ;;
    --project-path) PROJECT_PATH="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2";   shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="/tmp/mutagent-fetch-$$"
fi
mkdir -p "$OUTPUT_DIR"

CLAUDE_HOME="${HOME}/.claude/projects"
if [[ ! -d "$CLAUDE_HOME" ]]; then
  echo '{"error": "No ~/.claude/projects/ directory found. Is Claude Code installed?"}' > "$OUTPUT_DIR/last-Nh-meta.json"
  exit 1
fi

CUTOFF_EPOCH=$(date -v"-${HOURS}H" +%s 2>/dev/null || date -d "-${HOURS} hours" +%s 2>/dev/null || echo 0)

# Discover project directories
if [[ -n "$PROJECT_PATH" ]]; then
  PROJECT_DIRS=("$CLAUDE_HOME/$PROJECT_PATH")
else
  # bash 3.2 compatible (macOS): mapfile requires bash 4+
  PROJECT_DIRS=()
  while IFS= read -r p; do
    PROJECT_DIRS+=("$p")
  done < <(find "$CLAUDE_HOME" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
fi

META_ENTRIES='[]'
COUNT=0

for proj_dir in "${PROJECT_DIRS[@]}"; do
  [[ -d "$proj_dir" ]] || continue
  while IFS= read -r -d '' jsonl_file; do
    file_epoch=$(date -r "$jsonl_file" +%s 2>/dev/null || stat -c %Y "$jsonl_file" 2>/dev/null || echo 0)
    (( file_epoch >= CUTOFF_EPOCH )) || continue

    session_id=$(basename "$jsonl_file" .jsonl)
    dest="$OUTPUT_DIR/${session_id}.jsonl"
    cp "$jsonl_file" "$dest"

    # Extract minimal metadata without invoking LLM
    has_error="false"
    line_count=$(wc -l < "$jsonl_file" || echo 0)
    first_ts=$(head -1 "$jsonl_file" 2>/dev/null | grep -o '"timestamp":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
    last_ts=$(tail -1  "$jsonl_file" 2>/dev/null | grep -o '"timestamp":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
    if grep -q '"isError":true\|"is_error":true' "$jsonl_file" 2>/dev/null; then
      has_error="true"
    fi

    entry=$(printf '{
      "traceId": "%s",
      "sessionId": "%s",
      "sourcePlatform": "claude-code",
      "hasError": %s,
      "hasFeedback": false,
      "startTime": "%s",
      "endTime": "%s",
      "rawFilePath": "%s",
      "lineCount": %d
    }' "$session_id" "$session_id" "$has_error" "$first_ts" "$last_ts" "$dest" "$line_count")

    # R-002-A-v2: replaced inline bun eval + python3 heredoc with TS helper.
    # assemble-meta.ts reads prior array from stdin, appends entry, writes to stdout.
    # exits non-zero on parse failure (never silently falls back).
    META_ENTRIES=$(echo "$META_ENTRIES" | bash "$SKILL_ROOT/scripts/cli/run.sh" "$SKILL_ROOT/scripts/fetch/assemble-meta.ts" --entry "$entry")

    COUNT=$(( COUNT + 1 ))
  done < <(find "$proj_dir" -name "*.jsonl" -print0 2>/dev/null)
done

echo "$META_ENTRIES" > "$OUTPUT_DIR/last-Nh-meta.json"
echo "Fetched $COUNT sessions in last ${HOURS}h → $OUTPUT_DIR/last-Nh-meta.json" >&2
