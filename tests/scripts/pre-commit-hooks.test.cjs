'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const HOOK_DIR = path.join(ROOT, 'pre-commit.d');
const ORCHESTRATOR = path.join(ROOT, 'scripts', 'pre-commit-hook');

function runHook(hookName, envOverrides = {}) {
  const hookPath = path.join(HOOK_DIR, `${hookName}.sh`);
  try {
    const result = execFileSync('sh', [hookPath], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, ...envOverrides },
      timeout: 10000,
    });
    return { exitCode: 0, stdout: result };
  } catch (err) {
    return {
      exitCode: err.status || 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

function runOrchestrator(envOverrides = {}) {
  try {
    const result = execFileSync('sh', [ORCHESTRATOR], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, ...envOverrides },
      timeout: 60000,
    });
    return { exitCode: 0, stdout: result };
  } catch (err) {
    return {
      exitCode: err.status || 1,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
}

// --- Test: Hook scripts exist and are present ---
{
  const expectedHooks = ['check-format', 'check-lint', 'check-debug', 'check-secrets', 'check-large-files'];
  for (const hook of expectedHooks) {
    const hookPath = path.join(HOOK_DIR, `${hook}.sh`);
    const { existsSync } = require('fs');
    assert(existsSync(hookPath), `Hook script ${hook}.sh should exist`);
  }
  console.log('PASS: All hook scripts exist');
}

// --- Test: SKIP mechanism works per-hook ---
{
  const result = runHook('check-debug', { SKIP: 'check-debug' });
  assert.strictEqual(result.exitCode, 0, 'check-debug should pass when skipped');
  assert(result.stdout.includes('skipped'), 'Should print skipped message');
  console.log('PASS: SKIP=hook-name works');
}

// --- Test: SKIP_PRECOMMIT=1 skips orchestrator ---
{
  const result = runOrchestrator({ SKIP_PRECOMMIT: '1' });
  assert.strictEqual(result.exitCode, 0);
  assert(result.stdout.includes('skipped'), 'Orchestrator should report skipped');
  console.log('PASS: SKIP_PRECOMMIT=1 works');
}

// --- Test: check-debug detects console.log ---
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verinode-hook-test-'));
  try {
    // Initialize a temp git repo
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

    writeFileSync(path.join(dir, 'bad.ts'), 'console.log("debug");\n');
    execFileSync('git', ['add', 'bad.ts'], { cwd: dir });

    const result = execFileSync('sh', [path.join(HOOK_DIR, 'check-debug.sh')], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env },
      timeout: 10000,
    });
    assert.fail('Should have failed for console.log');
  } catch (err) {
    assert(err.status !== 0, 'check-debug should fail for console.log');
    const output = (err.stdout || '') + (err.stderr || '');
    assert(output.includes('debug') || output.includes('bad.ts'), 'Should mention the file or debug');
    console.log('PASS: check-debug detects console.log');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Test: check-debug passes for clean file ---
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verinode-hook-test-'));
  try {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

    writeFileSync(path.join(dir, 'good.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', 'good.ts'], { cwd: dir });

    const result = execFileSync('sh', [path.join(HOOK_DIR, 'check-debug.sh')], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env },
      timeout: 10000,
    });
    assert(result.includes('passed'), 'check-debug should pass for clean file');
    console.log('PASS: check-debug passes for clean file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Test: check-secrets detects AWS key pattern ---
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verinode-hook-test-'));
  try {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

    writeFileSync(path.join(dir, 'config.ts'), 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    execFileSync('git', ['add', 'config.ts'], { cwd: dir });

    try {
      execFileSync('sh', [path.join(HOOK_DIR, 'check-secrets.sh')], {
        encoding: 'utf8',
        cwd: dir,
        timeout: 10000,
      });
      assert.fail('Should have failed for AWS key');
    } catch (err) {
      assert(err.status !== 0, 'check-secrets should fail for AWS key');
      console.log('PASS: check-secrets detects AWS key');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Test: check-secrets detects JWT token ---
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verinode-hook-test-'));
  try {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    writeFileSync(path.join(dir, 'auth.ts'), `const token = "${jwt}";\n`);
    execFileSync('git', ['add', 'auth.ts'], { cwd: dir });

    try {
      execFileSync('sh', [path.join(HOOK_DIR, 'check-secrets.sh')], {
        encoding: 'utf8',
        cwd: dir,
        timeout: 10000,
      });
      assert.fail('Should have failed for JWT');
    } catch (err) {
      assert(err.status !== 0, 'check-secrets should fail for JWT');
      console.log('PASS: check-secrets detects JWT token');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Test: check-secrets passes for clean file ---
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verinode-hook-test-'));
  try {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

    writeFileSync(path.join(dir, 'clean.ts'), 'export const ok = true;\n');
    execFileSync('git', ['add', 'clean.ts'], { cwd: dir });

    const result = execFileSync('sh', [path.join(HOOK_DIR, 'check-secrets.sh')], {
      encoding: 'utf8',
      cwd: dir,
      timeout: 10000,
    });
    assert(result.includes('passed'), 'check-secrets should pass for clean file');
    console.log('PASS: check-secrets passes for clean file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Test: check-large-files rejects file > 1MB ---
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verinode-hook-test-'));
  try {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

    // Create a 1.5 MB file
    const bigContent = 'x'.repeat(1536 * 1024);
    writeFileSync(path.join(dir, 'big.bin'), bigContent);
    execFileSync('git', ['add', 'big.bin'], { cwd: dir });

    try {
      execFileSync('sh', [path.join(HOOK_DIR, 'check-large-files.sh')], {
        encoding: 'utf8',
        cwd: dir,
        timeout: 10000,
      });
      assert.fail('Should have failed for large file');
    } catch (err) {
      assert(err.status !== 0, 'check-large-files should fail for >1MB file');
      console.log('PASS: check-large-files rejects >1MB file');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Test: check-large-files passes for small file ---
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verinode-hook-test-'));
  try {
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

    writeFileSync(path.join(dir, 'small.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', 'small.ts'], { cwd: dir });

    const result = execFileSync('sh', [path.join(HOOK_DIR, 'check-large-files.sh')], {
      encoding: 'utf8',
      cwd: dir,
      timeout: 10000,
    });
    assert(result.includes('passed'), 'check-large-files should pass for small file');
    console.log('PASS: check-large-files passes for small file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Test: Multi-hook skip via comma-separated SKIP ---
{
  const result = runOrchestrator({
    SKIP: 'check-debug,check-secrets,check-large-files',
  });
  // Should pass since format/lint hooks skip themselves when tools aren't installed
  assert.strictEqual(result.exitCode, 0, 'Orchestrator should pass when hooks are skipped');
  console.log('PASS: Multi-hook SKIP works');
}

// --- Test: Legacy pre-commit-checks.cjs still exports correctly ---
{
  const mod = require('../../scripts/pre-commit-checks.cjs');
  assert(typeof mod.scanFiles === 'function', 'scanFiles should be exported');
  assert(typeof mod.shouldReadAsText === 'function', 'shouldReadAsText should be exported');
  assert(mod.DEBUG_PATTERN instanceof RegExp, 'DEBUG_PATTERN should be a RegExp');
  assert(mod.SECRET_PATTERN instanceof RegExp, 'SECRET_PATTERN should be a RegExp');
  assert(mod.MERGE_CONFLICT_PATTERN instanceof RegExp, 'MERGE_CONFLICT_PATTERN should be a RegExp');
  console.log('PASS: Legacy pre-commit-checks.cjs exports intact');
}

console.log('\nAll pre-commit hook tests passed');
