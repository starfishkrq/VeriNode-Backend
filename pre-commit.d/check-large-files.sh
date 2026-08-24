#!/bin/sh
# check-large-files.sh — Large file detection
# Rejects staged files larger than 1 MB
# Exception: files marked in .gitattributes with linguist-vendored or test-fixture
# Skip: SKIP=check-large-files git commit
set -eu

HOOK_NAME="check-large-files"

# --- skip gate ---
if echo ",${SKIP:-}," | grep -q ",${HOOK_NAME},"; then
  echo "pre-commit [${HOOK_NAME}]: skipped"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

MAX_BYTES=1048576  # 1 MB

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR || true)

if [ -z "$STAGED_FILES" ]; then
  echo "pre-commit [${HOOK_NAME}]: no staged files to check"
  exit 0
fi

# Build exception list from .gitattributes
EXCEPTIONS=""
if [ -f ".gitattributes" ]; then
  EXCEPTIONS=$(grep -E '(linguist-vendored|linguist-generated|test-fixture)' .gitattributes \
    | awk '{print $1}' || true)
fi

is_excepted() {
  local file="$1"
  if [ -z "$EXCEPTIONS" ]; then return 1; fi
  echo "$EXCEPTIONS" | while IFS= read -r pattern; do
    case "$file" in
      $pattern) exit 0 ;;
    esac
  done
  return 1
}

TMPFAIL=$(mktemp)
trap 'rm -f "$TMPFAIL"' EXIT

echo "$STAGED_FILES" | while IFS= read -r file; do
  [ -f "$file" ] || continue
  # Skip deleted files
  if git diff --cached --diff-filter=D --name-only | grep -qxF "$file"; then
    continue
  fi
  FILE_SIZE=$(wc -c < "$file" 2>/dev/null || echo 0)
  if [ "$FILE_SIZE" -gt "$MAX_BYTES" ]; then
    if is_excepted "$file"; then
      echo "pre-commit [${HOOK_NAME}]: ${file} (${FILE_SIZE} bytes) — exception via .gitattributes"
    else
      SIZE_KB=$((FILE_SIZE / 1024))
      echo "pre-commit [${HOOK_NAME}]: ${file} is ${SIZE_KB} KB (exceeds 1 MB limit)"
      echo "$file" >> "$TMPFAIL"
    fi
  fi
done

if [ -s "$TMPFAIL" ]; then
  echo ""
  echo "pre-commit [${HOOK_NAME}]: large files rejected:"
  while IFS= read -r f; do
    SIZE=$(wc -c < "$f" 2>/dev/null || echo 0)
    SIZE_KB=$((SIZE / 1024))
    echo "  ${f} — ${SIZE_KB} KB"
  done < "$TMPFAIL"
  echo ""
  echo "  To allow a file, add an exception in .gitattributes:"
  echo "    <path>  test-fixture"
  exit 1
fi

echo "pre-commit [${HOOK_NAME}]: passed"
exit 0
