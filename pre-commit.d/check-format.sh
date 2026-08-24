#!/bin/sh
# check-format.sh — Format verification hook
# Checks: prettier for TS/JS, cargo fmt for Rust
# Skip: SKIP=check-format git commit
set -eu

HOOK_NAME="check-format"

# --- skip gate ---
if echo ",${SKIP:-}," | grep -q ",${HOOK_NAME},"; then
  echo "pre-commit [${HOOK_NAME}]: skipped"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

FAIL=0

# --- Prettier (TypeScript / JavaScript) ---
PRETTIER_FILES=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '\.(ts|tsx|js|mjs|cjs|json|md|yaml|yml)$' || true)

if [ -n "$PRETTIER_FILES" ]; then
  if command -v npx >/dev/null 2>&1 && [ -f "node_modules/.bin/prettier" ]; then
    echo "pre-commit [${HOOK_NAME}]: running prettier..."
    echo "$PRETTIER_FILES" | xargs npx prettier --check 2>&1 || {
      echo "pre-commit [${HOOK_NAME}]: prettier found formatting issues"
      echo "  Run: npx prettier --write <file> to fix"
      FAIL=1
    }
  else
    echo "pre-commit [${HOOK_NAME}]: prettier not installed, skipping format check"
    echo "  Install: npm install --save-dev prettier"
  fi
fi

# --- cargo fmt (Rust) ---
RUST_FILES=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '\.rs$' || true)

if [ -n "$RUST_FILES" ]; then
  if command -v cargo >/dev/null 2>&1; then
    echo "pre-commit [${HOOK_NAME}]: running cargo fmt --check..."
    # Find the nearest Cargo.toml and run fmt from there
    CARGO_DIR=$(echo "$RUST_FILES" | head -1 | xargs dirname)
    while [ "$CARGO_DIR" != "." ] && [ "$CARGO_DIR" != "/" ]; do
      if [ -f "${CARGO_DIR}/Cargo.toml" ]; then break; fi
      CARGO_DIR=$(dirname "$CARGO_DIR")
    done
    (cd "$CARGO_DIR" && cargo fmt --check) 2>&1 || {
      echo "pre-commit [${HOOK_NAME}]: cargo fmt found formatting issues"
      echo "  Run: cargo fmt to fix"
      FAIL=1
    }
  else
    echo "pre-commit [${HOOK_NAME}]: cargo not installed, skipping Rust format check"
  fi
fi

exit $FAIL
