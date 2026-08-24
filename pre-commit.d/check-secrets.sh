#!/bin/sh
# check-secrets.sh — Secret and credential detection
# Checks: AWS keys, private keys, JWT tokens, generic secret keywords
# Skip: SKIP=check-secrets git commit
set -eu

HOOK_NAME="check-secrets"

# --- skip gate ---
if echo ",${SKIP:-}," | grep -q ",${HOOK_NAME},"; then
  echo "pre-commit [${HOOK_NAME}]: skipped"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Text extensions to scan
TEXT_EXTS="ts|tsx|js|mjs|cjs|rs|sh|py|env|json|yaml|yml|toml|cfg|conf|ini"
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E "\.(${TEXT_EXTS})$" || true)

if [ -z "$STAGED_FILES" ]; then
  echo "pre-commit [${HOOK_NAME}]: no text files to scan"
  exit 0
fi

# Secret patterns (ERE)
# AWS access key: AKIA followed by 16 alphanumeric
# Generic secret keywords: private_key, api_key, secret_key, access_token, password, passwd
# JWT token: three base64url segments separated by dots
PATTERNS='(AKIA[0-9A-Z]{16})|(private[_-]?key|api[_-]?key|secret[_-]?key|access[_-]?token|password|passwd)[[:space:]]*[:=]|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+'

TMPFAIL=$(mktemp)
trap 'rm -f "$TMPFAIL"' EXIT

echo "$STAGED_FILES" | while IFS= read -r file; do
  [ -f "$file" ] || continue
  # Skip hook fixtures, documentation, and test fixtures
  case "$file" in
    pre-commit.d/*|tests/scripts/*|docs/*|*.test.*|*fixture*|*mock*) continue ;;
  esac
  if grep -qE "$PATTERNS" "$file" 2>/dev/null; then
    echo "$file" >> "$TMPFAIL"
    grep -nE "$PATTERNS" "$file" 2>/dev/null | sed "s|^|  ${file}:|"
  fi
done

if [ -s "$TMPFAIL" ]; then
  COUNT=$(wc -l < "$TMPFAIL")
  echo ""
  echo "pre-commit [${HOOK_NAME}]: potential secrets in ${COUNT} file(s)"
  echo "  Review each match. If it is a false positive, add the file to"
  echo "  the exclusion list in check-secrets.sh."
  exit 1
fi

echo "pre-commit [${HOOK_NAME}]: passed"
exit 0
