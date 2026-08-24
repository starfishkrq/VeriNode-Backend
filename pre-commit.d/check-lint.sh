#!/bin/sh
# check-lint.sh — Lint verification hook
# Checks: eslint for TS/JS, cargo clippy for Rust
# Skip: SKIP=check-lint git commit
set -eu

HOOK_NAME="check-lint"

# --- skip gate ---
if echo ",${SKIP:-}," | grep -q ",${HOOK_NAME},"; then
  echo "pre-commit [${HOOK_NAME}]: skipped"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

FAIL=0

# --- ESLint (TypeScript / JavaScript) ---
ESLINT_FILES=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '\.(ts|tsx|js|mjs|cjs)$' || true)

if [ -n "$ESLINT_FILES" ]; then
  if command -v npx >/dev/null 2>&1 && [ -f "node_modules/.bin/eslint" ]; then
    echo "pre-commit [${HOOK_NAME}]: running eslint..."
    echo "$ESLINT_FILES" | xargs npx eslint --no-error-on-unmatched-pattern 2>&1 || {
      echo "pre-commit [${HOOK_NAME}]: eslint found lint issues"
      FAIL=1
    }
  else
    echo "pre-commit [${HOOK_NAME}]: eslint not installed, skipping lint check"
    echo "  Install: npm install --save-dev eslint"
  fi
fi

# --- cargo clippy (Rust) ---
RUST_FILES=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '\.rs$' || true)

if [ -n "$RUST_FILES" ]; then
  if command -v cargo >/dev/null 2>&1; then
    echo "pre-commit [${HOOK_NAME}]: running cargo clippy..."
    CARGO_DIR=$(echo "$RUST_FILES" | head -1 | xargs dirname)
    while [ "$CARGO_DIR" != "." ] && [ "$CARGO_DIR" != "/" ]; do
      if [ -f "${CARGO_DIR}/Cargo.toml" ]; then break; fi
      CARGO_DIR=$(dirname "$CARGO_DIR")
    done
    (cd "$CARGO_DIR" && cargo clippy --all-targets -- -D warnings) 2>&1 || {
      echo "pre-commit [${HOOK_NAME}]: cargo clippy found lint issues"
      FAIL=1
    }
  else
    echo "pre-commit [${HOOK_NAME}]: cargo not installed, skipping Rust lint check"
  fi
fi

exit $FAIL
