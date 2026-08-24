# Pre-Commit Hook Suite

VeriNode ships a modular pre-commit hook suite that catches quality and security issues locally before code reaches CI.

## Architecture

The hook entrypoint is `scripts/pre-commit-hook`. It resolves the repository root and runs each check script in `pre-commit.d/` sequentially. A 30-second total timeout prevents hooks from blocking commits.

Each hook is a standalone shell script:

| Hook | File | What it checks |
|------|------|----------------|
| `check-format` | `pre-commit.d/check-format.sh` | Prettier (TS/JS), `cargo fmt` (Rust) |
| `check-lint` | `pre-commit.d/check-lint.sh` | ESLint (TS/JS), `cargo clippy` (Rust) |
| `check-debug` | `pre-commit.d/check-debug.sh` | `console.log`, `debugger`, `println!`, `dbg!`, `todo!` |
| `check-secrets` | `pre-commit.d/check-secrets.sh` | AWS keys, private keys, JWT tokens, generic secret keywords |
| `check-large-files` | `pre-commit.d/check-large-files.sh` | Files exceeding 1 MB |

All hooks scan only staged files for fast execution.

## Installation

```sh
./install-hooks.sh
```

The installer:
1. Copies `scripts/pre-commit-hook` to `.git/hooks/pre-commit`
2. Makes all `pre-commit.d/*.sh` scripts executable

## Usage

```sh
# Run all hooks (default)
git commit

# Skip specific hook(s) by name
SKIP=check-lint git commit
SKIP=check-lint,check-debug git commit

# Skip all hooks (emergency break-glass)
SKIP_PRECOMMIT=1 git commit

# Include TypeScript build + full test suite
VERINODE_PRECOMMIT_FULL=1 git commit
```

## Per-Hook Skip

Use the `SKIP` environment variable with a comma-separated list of hook names:

```sh
SKIP=check-format,check-secrets git commit
```

Valid hook names: `check-format`, `check-lint`, `check-debug`, `check-secrets`, `check-large-files`.

## Large File Exceptions

The `check-large-files` hook rejects staged files larger than 1 MB. To allow specific files (e.g., test fixtures, certificates), add exceptions in `.gitattributes`:

```
tests/fixtures/**    test-fixture
*.pem                test-fixture
```

Files matched by `test-fixture`, `linguist-vendored`, or `linguist-generated` attributes are exempt.

## Tool Availability

Hooks gracefully skip checks when the required tool is not installed:

- **Prettier**: skipped if `npx` or `node_modules/.bin/prettier` is missing. Install with `npm install --save-dev prettier`.
- **ESLint**: skipped if `npx` or `node_modules/.bin/eslint` is missing. Install with `npm install --save-dev eslint`.
- **Cargo/Rust tools**: skipped if `cargo` is not in `PATH`.

## CI Integration

The same checks run in CI via `.github/workflows/ci.yml` in the `pre-commit` job. In CI, format and lint checks are skipped (they require installed toolchains); debug, secrets, and large file checks run against all tracked files.

## Timeout

The orchestrator enforces a 30-second total timeout across all hooks. If the timeout is reached, remaining hooks are skipped and the commit is blocked. This prevents slow hooks (e.g., `cargo clippy` on a cold cache) from blocking developer workflow.

## Operations and Runbook

1. If a commit is blocked, read the file-specific failure list printed by the hook.
2. Fix the flagged file and restage it.
3. Use `VERINODE_PRECOMMIT_FULL=1 git commit` before changes that affect critical paths, security-sensitive code, or deployment logic.
4. Only use `SKIP_PRECOMMIT=1 git commit` for emergency break-glass commits, and document the reason in the pull request.

## Monitoring and Rollout

Pre-commit hooks run locally and do not affect production availability. Roll out by installing the hook on developer workstations and CI images. CI should continue to run build, test, and security jobs independently so failures remain visible even when a local hook is bypassed.
