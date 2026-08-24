#!/bin/sh
# check-debug.sh — Debug and panic statement detection
# Checks: console.log, debugger, println!, dbg!, todo!
# Skip: SKIP=check-debug git commit
set -eu

HOOK_NAME="check-debug"

# --- skip gate ---
if echo ",${SKIP:-}," | grep -q ",${HOOK_NAME},"; then
  echo "pre-commit [${HOOK_NAME}]: skipped"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Text extensions to scan
TEXT_EXTS="ts|tsx|js|mjs|cjs|rs|sh|py"
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E "\.(${TEXT_EXTS})$" || true)

if [ -z "$STAGED_FILES" ]; then
  echo "pre-commit [${HOOK_NAME}]: no text files to scan"
  exit 0
fi

# Patterns: JS debug + Rust debug/panic
PATTERN='(console\.log|debugger|println!|dbg!\(|todo!())'

TMPFAIL=$(mktemp)
trap 'rm -f "$TMPFAIL"' EXIT

echo "$STAGED_FILES" | while IFS= read -r file; do
  [ -f "$file" ] || continue
  # Skip hook fixtures and documentation
  case "$file" in
    pre-commit.d/*|tests/scripts/*|docs/*) continue ;;
  esac
  if grep -qE "$PATTERN" "$file" 2>/dev/null; then
    echo "$file" >> "$TMPFAIL"
    # Print matching lines for context
    grep -nE "$PATTERN" "$file" 2>/dev/null | sed "s|^|  ${file}:|"
  fi
done

if [ -s "$TMPFAIL" ]; then
  COUNT=$(wc -l < "$TMPFAIL")
  echo ""
  echo "pre-commit [${HOOK_NAME}]: ${COUNT} file(s) contain debug/panic statements"
  echo "  Remove them before committing."
  exit 1
fi

echo "pre-commit [${HOOK_NAME}]: passed"
exit 0
