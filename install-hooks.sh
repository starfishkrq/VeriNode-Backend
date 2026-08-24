#!/bin/sh
set -eu

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# Ensure .git/hooks directory exists
mkdir -p .git/hooks

# Install the orchestrator as the git pre-commit hook
cp scripts/pre-commit-hook .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

# Ensure all hook scripts in pre-commit.d/ are executable
if [ -d "pre-commit.d" ]; then
  for hook in pre-commit.d/*.sh; do
    [ -f "$hook" ] && chmod +x "$hook"
  done
fi

echo "Installed VeriNode pre-commit hook suite:"
echo "  Orchestrator:  .git/hooks/pre-commit"
echo "  Hook scripts:  pre-commit.d/*.sh"
echo ""
echo "Usage:"
echo "  git commit                              # run all hooks"
echo "  SKIP=check-lint git commit              # skip specific hook(s)"
echo "  SKIP=check-lint,check-debug git commit  # skip multiple hooks"
echo "  SKIP_PRECOMMIT=1 git commit             # skip all hooks"
echo "  VERINODE_PRECOMMIT_FULL=1 git commit    # add build + test suite"
