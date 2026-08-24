/**
 * Property-based test suite for TwoPhaseController + RollbackHandler.
 *
 * Core property under test:
 *   ∀ node ∈ node_status:
 *     IF node.status ≠ initialStatus
 *     THEN ∃ tentative row WITH state = 'COMMITTED'
 *
 * In other words: node_status MUST NEVER contain a status that was not
 * confirmed on-chain, even when 20% of Soroban calls fail mid-flight.
 *
 * Secondary properties:
 *   - Every rolled-back transition appears in two_phase_rollback_log.
 *   - committed + rolledBack + errors = total attempts (no silent drops).
 *   - getNodeStatus returns tentative: true only for in-flight PENDING rows.
 *   - resolveTentative admin path correctly force-commits and force-rolls-back.
 *   - TentativeCleanupWorker sweeps expired rows and does NOT double-process.
 */

import { strict as assert } from 'assert';
import { createHash }       from 'crypto';

import {
  TwoPhaseController,
  NodeStatus,
  TwoPhaseDb,
  QueryOpts,
} from '../src/core/state/two_phase_controller';

import {
  RollbackHandler,
  TransactionClient,
} from '../src/core/state/rollback_handler';

import {
  TentativeCleanupWorker,
} from '../src/core/state/tentative_cleanup_worker';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory fakes
// ─────────────────────────────────────────────────────────────────────────────

interface FakeNodeRow {
  node_id: string;
  status:  NodeStatus;
}

interface FakeTentativeRow {
  node_id:         string;
  target_status:   NodeStatus;
  idempotency_key: string;
  state:           'PENDING' | 'COMMITTED' | 'ROLLED_BACK';
  created_at:      Date;
  expires_at:      Date;
  error_detail?:   string;
  resolved_at?:    Date;
}

interface FakeRollbackLogRow {
  node_id:         string;
  idempotency_key: string;
  target_status:   string;
  failure_reason:  string;
}

interface PendingWrite { sql: string; params: any[]; }

/**
 * Shared in-memory store satisfying TwoPhaseDb and CleanupDb.
 */
class FakeStore implements TwoPhaseDb {
  readonly nodes       = new Map<string, FakeNodeRow>();
  readonly tentatives  = new Map<string, FakeTentativeRow>();
  readonly rollbackLog: FakeRollbackLogRow[] = [];

  async query<T extends Record<string, any> = any>(
    sql: string,
    params: any[] = [],
    _opts?: QueryOpts,
  ): Promise<{ rows: T[]; rowCount: number }> {
    const u = sql.trim().toUpperCase().replace(/\s+/g, ' ');

    // node_status committed read
    if (u.includes('SELECT STATUS FROM NODE_STATUS WHERE NODE_ID')) {
      const row = this.nodes.get(params[0] as string);
      return row
        ? { rows: [{ status: row.status }] as unknown as T[], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }

    // tentative: PENDING + not-expired (getNodeStatus read guard)
    if (
      u.includes('FROM NODE_STATUS_TENTATIVE') &&
      u.includes("STATE = 'PENDING'") &&
      u.includes('EXPIRES_AT > NOW()')
    ) {
      const t = this.tentatives.get(params[0] as string);
      if (t && t.state === 'PENDING' && t.expires_at > new Date()) {
        return {
          rows: [{
            target_status:   t.target_status,
            idempotency_key: t.idempotency_key,
            expires_at:      t.expires_at,
          }] as unknown as T[],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }

    // tentative: PENDING + expired (cleanup worker sweep)
    if (
      u.includes('FROM NODE_STATUS_TENTATIVE') &&
      u.includes("STATE = 'PENDING'") &&
      u.includes('EXPIRES_AT < NOW()')
    ) {
      const limit = (params[0] as number) ?? 50;
      const expired = [...this.tentatives.values()]
        .filter((t) => t.state === 'PENDING' && t.expires_at < new Date())
        .sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime())
        .slice(0, limit);
      return {
        rows: expired.map((t) => ({
          node_id:         t.node_id,
          idempotency_key: t.idempotency_key,
          target_status:   t.target_status,
        })) as unknown as T[],
        rowCount: expired.length,
      };
    }

    // tentative Phase-1 upsert (atomic PENDING guard)
    // MUST be checked BEFORE the raw lookup below, because the INSERT SQL
    // contains "FROM NODE_STATUS_TENTATIVE WHERE node_id" in the WHERE NOT EXISTS
    // subquery which would incorrectly match the raw lookup branch.
    if (u.includes('INSERT INTO NODE_STATUS_TENTATIVE')) {
      const [nodeId, targetStatus, idempotencyKey] = params as [string, NodeStatus, string];
      const existing = this.tentatives.get(nodeId);

      // WHERE NOT EXISTS: reject if a PENDING row already exists
      if (existing && existing.state === 'PENDING') {
        return { rows: [], rowCount: 0 };
      }

      // ON CONFLICT path: overwrite resolved (COMMITTED/ROLLED_BACK) rows
      // or insert fresh if no row exists
      this.tentatives.set(nodeId, {
        node_id:         nodeId,
        target_status:   targetStatus,
        idempotency_key: idempotencyKey,
        state:           'PENDING',
        created_at:      new Date(),
        expires_at:      new Date(Date.now() + 30_000),
      });
      return { rows: [], rowCount: 1 };
    }

    // Best-effort marker for commit-path failure (Fix 6)
    // MUST be checked BEFORE the raw lookup below.
    if (
      u.includes('UPDATE NODE_STATUS_TENTATIVE') &&
      u.includes('ERROR_DETAIL') &&
      u.includes('COMMIT_FAILED')
    ) {
      const nodeId = params[0] as string;
      const t = this.tentatives.get(nodeId);
      if (t && t.state === 'PENDING') {
        t.error_detail = 'COMMIT_FAILED_ONCHAIN_CONFIRMED';
      }
      return { rows: [], rowCount: t ? 1 : 0 };
    }

    // tentative: raw lookup by node_id (fetchTentativeRow / resolveTentative)
    if (u.includes('FROM NODE_STATUS_TENTATIVE') && u.includes('WHERE NODE_ID')) {
      const t = this.tentatives.get(params[0] as string);
      return t
        ? {
            rows: [{
              target_status:   t.target_status,
              idempotency_key: t.idempotency_key,
              state:           t.state,
              expires_at:      t.expires_at,
            }] as unknown as T[],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(fn: (client: FakeTxClient) => Promise<T>): Promise<T> {
    const client = new FakeTxClient(this);
    const result = await fn(client);
    client.commit();
    return result;
  }
}

/** Batches writes and applies them atomically on commit(). */
class FakeTxClient implements TransactionClient {
  private readonly writes: PendingWrite[] = [];
  constructor(private readonly store: FakeStore) {}

  async query(sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    // Pre-evaluate CAS rowCount for the rollback path BEFORE deferring the write.
    // This allows RollbackHandler to correctly detect double-rollback.
    const u = sql.trim().toUpperCase().replace(/\s+/g, ' ');
    let rowCount = 1;

    if (u.includes('UPDATE NODE_STATUS_TENTATIVE') && u.includes("STATE = 'ROLLED_BACK'")) {
      const nodeId = params[1] as string; // params = [reason, nodeId]
      const t = this.store.tentatives.get(nodeId);
      rowCount = (t && t.state === 'PENDING') ? 1 : 0;
    }

    this.writes.push({ sql, params });
    return { rows: [], rowCount };
  }

  commit(): void {
    for (const { sql, params } of this.writes) {
      this.apply(sql, params);
    }
  }

  private apply(sql: string, params: any[]): void {
    const u = sql.trim().toUpperCase().replace(/\s+/g, ' ');

    // Commit path: promote node_status
    if (u.includes('UPDATE NODE_STATUS') && u.includes('SET STATUS')) {
      const [status, nodeId] = params as [NodeStatus, string];
      const row = this.store.nodes.get(nodeId);
      if (row) row.status = status;
    }

    // Commit path: mark tentative COMMITTED
    if (u.includes('UPDATE NODE_STATUS_TENTATIVE') && u.includes("STATE = 'COMMITTED'")) {
      const nodeId = params[0] as string;
      const t = this.store.tentatives.get(nodeId);
      if (t) { t.state = 'COMMITTED'; t.resolved_at = new Date(); }
    }

    // Rollback path: mark tentative ROLLED_BACK (CAS: only if PENDING)
    if (u.includes('UPDATE NODE_STATUS_TENTATIVE') && u.includes("STATE = 'ROLLED_BACK'")) {
      const [reason, nodeId] = params as [string, string];
      const t = this.store.tentatives.get(nodeId);
      if (t && t.state === 'PENDING') {
        t.state        = 'ROLLED_BACK';
        t.error_detail = reason;
        t.resolved_at  = new Date();
      }
    }

    // Rollback log insert
    if (u.includes('INSERT INTO TWO_PHASE_ROLLBACK_LOG')) {
      const [nodeId, idempotencyKey, targetStatus, failureReason] =
        params as [string, string, string, string];
      this.store.rollbackLog.push({
        node_id: nodeId, idempotency_key: idempotencyKey,
        target_status: targetStatus, failure_reason: failureReason,
      });
    }

    // Cascade deletes (reward_tx, node_attestations, reputation_adjustments):
    // Not modelled in this fake — no-op is intentional; correctness property
    // only asserts on node_status.
  }
}

/** Fake Soroban RPC: configurable failure rate per call. */
class FakeRpc {
  private callCount = 0;
  constructor(private readonly failureRate: number) {}

  async sendTransaction(_tx: string): Promise<{
    hash: string; success: boolean; error?: { code: number; message: string };
  }> {
    this.callCount++;
    if (Math.random() < this.failureRate) {
      return { hash: '', success: false,
               error: { code: -32603, message: 'HostError: InsufficientBalance' } };
    }
    return {
      hash: `0x${createHash('sha256').update(String(this.callCount)).digest('hex')}`,
      success: true,
    };
  }

  async simulateTransaction(_tx: string): Promise<{ latestLedger: string }> {
    return { latestLedger: String(Math.floor(Math.random() * 1_000_000) + 10_000) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny test runner — matches the project's ts-node / assert style
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error
      ? `${err.message}\n      ${(err.stack ?? '').split('\n').slice(1, 3).join('\n      ')}`
      : String(err);
    failures.push(`  ✗ ${name}:\n      ${msg}`);
    process.stdout.write(`  ✗ ${name}\n      ${msg}\n`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildStack(failureRate = 0.20) {
  const store   = new FakeStore();
  const rpc     = new FakeRpc(failureRate);
  const handler = new RollbackHandler(store);
  const ctrl    = new TwoPhaseController(store, rpc, handler, 'CONTRACT_TEST');
  return { store, rpc, handler, ctrl };
}

function seedNodes(
  store: FakeStore, count: number, status: NodeStatus = 'Provisioned',
): string[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `node-${String(i).padStart(4, '0')}`;
    store.nodes.set(id, { node_id: id, status });
    return id;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {

  // ── Test 1: Core invariant — 100 concurrent transitions at 20% failure rate ─
  await test(
    'INVARIANT: node_status never contains uncommitted status under 20% contract failure rate',
    async () => {
      const { store, ctrl } = buildStack(0.20);
      const nodeIds = seedNodes(store, 100, 'Provisioned');

      const results = await Promise.allSettled(
        nodeIds.map((id) => ctrl.transition(id, 'Pending')),
      );

      let committed  = 0;
      let rolledBack = 0;
      let errors     = 0;

      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value.committed)  committed++;
          if (r.value.rolledBack) rolledBack++;
        } else {
          errors++;
        }
      }

      // ── Core invariant ────────────────────────────────────────────────
      for (const [nodeId, node] of store.nodes) {
        const t = store.tentatives.get(nodeId);

        if (node.status === 'Pending') {
          assert.ok(
            t !== undefined && t.state === 'COMMITTED',
            `INVARIANT VIOLATED: ${nodeId} shows Pending in node_status ` +
              `but tentative.state = ${t?.state ?? 'missing'}`,
          );
        }

        if (node.status === 'Provisioned') {
          assert.ok(
            t === undefined || t.state !== 'COMMITTED',
            `INVARIANT VIOLATED: ${nodeId} shows Provisioned in node_status ` +
              `but tentative.state = COMMITTED`,
          );
        }
      }

      // ── Coverage invariant ─────────────────────────────────────────────
      assert.equal(
        committed + rolledBack + errors, 100,
        `committed(${committed}) + rolledBack(${rolledBack}) + errors(${errors}) ≠ 100`,
      );

      // ── Failure rate plausibility (5–45% allows for random variance) ───
      const actualRate = rolledBack / 100;
      assert.ok(
        actualRate >= 0.05 && actualRate <= 0.45,
        `Failure rate ${(actualRate * 100).toFixed(1)}% is implausibly far from 20%`,
      );

      console.log(
        `      ${committed} committed, ${rolledBack} rolled back` +
          ` (actual failure rate: ${(actualRate * 100).toFixed(1)}%)`,
      );
    },
  );

  // ── Test 2: Rollback log completeness ─────────────────────────────────────
  await test(
    'Every rolled-back transition is recorded in two_phase_rollback_log',
    async () => {
      const { store, ctrl } = buildStack(0.30);
      const nodeIds = seedNodes(store, 50, 'Provisioned');

      const results = await Promise.allSettled(
        nodeIds.map((id) => ctrl.transition(id, 'Pending')),
      );

      const actualRolledBack = results.filter(
        (r) => r.status === 'fulfilled' && r.value.rolledBack,
      ).length;

      assert.equal(
        store.rollbackLog.length, actualRolledBack,
        `rollback_log has ${store.rollbackLog.length} entries ` +
          `but ${actualRolledBack} transitions rolled back`,
      );
    },
  );

  // ── Test 3: Read-path guard — in-flight PENDING row ───────────────────────
  await test(
    'getNodeStatus returns tentative:true for unexpired PENDING rows',
    async () => {
      const { store, ctrl } = buildStack();
      const nodeId = 'node-read-a';
      store.nodes.set(nodeId, { node_id: nodeId, status: 'Provisioned' });

      store.tentatives.set(nodeId, {
        node_id: nodeId, target_status: 'Pending',
        idempotency_key: 'idem-read-a', state: 'PENDING',
        created_at: new Date(), expires_at: new Date(Date.now() + 25_000),
      });

      const result = await ctrl.getNodeStatus(nodeId);

      assert.ok(result !== null);
      assert.equal(result!.tentative, true);
      assert.equal(result!.status, 'Pending');
      assert.equal((result as any).idempotencyKey, 'idem-read-a');
    },
  );

  // ── Test 4: Read-path — committed node ────────────────────────────────────
  await test(
    'getNodeStatus returns tentative:false when no PENDING row exists',
    async () => {
      const { store, ctrl } = buildStack();
      const nodeId = 'node-read-b';
      store.nodes.set(nodeId, { node_id: nodeId, status: 'Active' });

      const result = await ctrl.getNodeStatus(nodeId);

      assert.ok(result !== null);
      assert.equal(result!.tentative, false);
      assert.equal(result!.status, 'Active');
    },
  );

  // ── Test 5: Illegal transition rejected pre-Phase-1 ───────────────────────
  await test(
    'Illegal transitions are rejected before writing any tentative record',
    async () => {
      const { store, ctrl } = buildStack();
      const nodeId = 'node-illegal';
      store.nodes.set(nodeId, { node_id: nodeId, status: 'Active' });

      await assert.rejects(
        () => ctrl.transition(nodeId, 'Provisioned'),
        /Illegal transition/,
      );

      assert.equal(store.tentatives.has(nodeId), false,
        'Phase-1 must not write for illegal transitions');
      assert.equal(store.nodes.get(nodeId)!.status, 'Active');
    },
  );

  // ── Test 6: Duplicate PENDING guard ───────────────────────────────────────
  await test(
    'A second concurrent transition is rejected while a PENDING row is live',
    async () => {
      const { store, ctrl } = buildStack();
      const nodeId = 'node-dup';
      store.nodes.set(nodeId, { node_id: nodeId, status: 'Provisioned' });

      store.tentatives.set(nodeId, {
        node_id: nodeId, target_status: 'Pending',
        idempotency_key: 'idem-existing', state: 'PENDING',
        created_at: new Date(), expires_at: new Date(Date.now() + 20_000),
      });

      await assert.rejects(
        () => ctrl.transition(nodeId, 'Pending'),
        /already has a PENDING tentative/,
      );
      assert.equal(store.nodes.get(nodeId)!.status, 'Provisioned');
    },
  );

  // ── Test 7: Admin resolveTentative — force commit ─────────────────────────
  await test(
    'resolveTentative("commit") promotes node_status and marks tentative COMMITTED',
    async () => {
      const { store, ctrl } = buildStack();
      const nodeId = 'node-admin-commit';
      store.nodes.set(nodeId, { node_id: nodeId, status: 'Provisioned' });

      store.tentatives.set(nodeId, {
        node_id: nodeId, target_status: 'Pending',
        idempotency_key: 'idem-stuck', state: 'PENDING',
        created_at: new Date(), expires_at: new Date(Date.now() + 15_000),
      });

      const res = await ctrl.resolveTentative(nodeId, 'commit');

      assert.equal(res.resolved, true);
      assert.equal(res.outcome, 'committed');
      assert.equal(store.nodes.get(nodeId)!.status, 'Pending');
      assert.equal(store.tentatives.get(nodeId)!.state, 'COMMITTED');
    },
  );

  // ── Test 8: Admin resolveTentative — force rollback ───────────────────────
  await test(
    'resolveTentative("rollback") marks tentative ROLLED_BACK and logs incident',
    async () => {
      const { store, ctrl } = buildStack();
      const nodeId = 'node-admin-rb';
      store.nodes.set(nodeId, { node_id: nodeId, status: 'Provisioned' });

      store.tentatives.set(nodeId, {
        node_id: nodeId, target_status: 'Pending',
        idempotency_key: 'idem-force-rb', state: 'PENDING',
        created_at: new Date(), expires_at: new Date(Date.now() + 15_000),
      });

      const res = await ctrl.resolveTentative(nodeId, 'rollback');

      assert.equal(res.resolved, true);
      assert.equal(res.outcome, 'rolled_back');
      // node_status MUST NOT have changed
      assert.equal(store.nodes.get(nodeId)!.status, 'Provisioned');
      assert.equal(store.tentatives.get(nodeId)!.state, 'ROLLED_BACK');
      assert.equal(store.rollbackLog.length, 1);
      assert.ok(store.rollbackLog[0].failure_reason.includes('Admin force-rollback'));
    },
  );

  // ── Test 9: Admin resolveTentative — no pending row ───────────────────────
  await test(
    'resolveTentative returns no_pending_row when nothing is in flight',
    async () => {
      const { store, ctrl } = buildStack();
      const nodeId = 'node-no-pending';
      store.nodes.set(nodeId, { node_id: nodeId, status: 'Active' });

      const res = await ctrl.resolveTentative(nodeId, 'commit');
      assert.equal(res.resolved, false);
      assert.equal(res.outcome, 'no_pending_row');
    },
  );

  // ── Test 10: Cleanup worker sweeps expired rows + no double-process ────────
  await test(
    'TentativeCleanupWorker sweeps expired PENDING rows and does not double-process',
    async () => {
      const store   = new FakeStore();
      const handler = new RollbackHandler(store);
      const worker  = new TentativeCleanupWorker(store, handler, { intervalMs: 999_999 });

      seedNodes(store, 3);
      const past   = new Date(Date.now() - 5_000);
      const future = new Date(Date.now() + 25_000);

      store.tentatives.set('node-0000', {
        node_id: 'node-0000', target_status: 'Pending',
        idempotency_key: 'key-exp-a', state: 'PENDING',
        created_at: past, expires_at: past,
      });
      store.tentatives.set('node-0001', {
        node_id: 'node-0001', target_status: 'Pending',
        idempotency_key: 'key-exp-b', state: 'PENDING',
        created_at: past, expires_at: past,
      });
      store.tentatives.set('node-0002', {
        node_id: 'node-0002', target_status: 'Pending',
        idempotency_key: 'key-live-c', state: 'PENDING',
        created_at: new Date(), expires_at: future,
      });

      const r1 = await worker.sweep();
      assert.equal(r1.processed, 2, `Expected 2 processed, got ${r1.processed}`);
      assert.equal(r1.skipped,   0, `Expected 0 skipped, got ${r1.skipped}`);

      assert.equal(store.tentatives.get('node-0000')!.state, 'ROLLED_BACK');
      assert.equal(store.tentatives.get('node-0001')!.state, 'ROLLED_BACK');
      assert.equal(store.tentatives.get('node-0002')!.state, 'PENDING');

      // node_status untouched for expired nodes
      assert.equal(store.nodes.get('node-0000')!.status, 'Provisioned');
      assert.equal(store.nodes.get('node-0001')!.status, 'Provisioned');

      assert.equal(store.rollbackLog.length, 2);
      assert.equal(worker.getMetrics().rollbacksTotal, 2);
      assert.equal(worker.getMetrics().sweepsTotal,    1);

      // Second sweep — rows are ROLLED_BACK, nothing to process
      const r2 = await worker.sweep();
      assert.equal(r2.processed, 0, 'Double-processing detected!');
      assert.equal(store.rollbackLog.length, 2, 'Rollback log grew on re-sweep');
      assert.equal(worker.getMetrics().sweepsTotal, 2);
    },
  );

  // ── Test 11: Idempotency key determinism + collision resistance ───────────
  await test(
    'buildIdempotencyKey is deterministic and collision-resistant',
    async () => {
      const k1 = TwoPhaseController.buildIdempotencyKey('node-abc', 12345, 'nonce-1');
      const k2 = TwoPhaseController.buildIdempotencyKey('node-abc', 12345, 'nonce-1');
      const k3 = TwoPhaseController.buildIdempotencyKey('node-abc', 12345, 'nonce-2');
      const k4 = TwoPhaseController.buildIdempotencyKey('node-abc', 12346, 'nonce-1');
      const k5 = TwoPhaseController.buildIdempotencyKey('node-xyz', 12345, 'nonce-1');

      assert.equal(k1, k2, 'Same inputs must produce same key');
      assert.equal(new Set([k1, k3, k4, k5]).size, 4, 'Different inputs must differ');
      assert.match(k1, /^[0-9a-f]{64}$/, 'Must be 64-char SHA-256 hex');
    },
  );

  // ── Test 12: Unknown node rejects before Phase-1 ─────────────────────────
  await test(
    'Transition on unknown nodeId throws before any Phase-1 write',
    async () => {
      const { store, ctrl } = buildStack();

      await assert.rejects(
        () => ctrl.transition('ghost-node', 'Pending'),
        /not found/,
      );
      assert.equal(store.tentatives.size, 0, 'Tentative row must not be created');
    },
  );

  // ── Test 13: Prometheus metrics format ────────────────────────────────────
  await test(
    'TentativeCleanupWorker.prometheusMetrics() emits well-formed text',
    async () => {
      const store  = new FakeStore();
      const worker = new TentativeCleanupWorker(
        store, new RollbackHandler(store), { intervalMs: 999_999 },
      );
      const output = worker.prometheusMetrics();
      assert.match(output, /^# HELP two_phase_rollbacks_total/m);
      assert.match(output, /^# TYPE two_phase_rollbacks_total counter/m);
      assert.match(output, /^two_phase_rollbacks_total 0/m);
      assert.match(output, /^two_phase_sweep_total 0/m);
    },
  );

  // ── Test 14: Full state machine path (Provisioned→Pending→Active) ─────────
  await test(
    'Full happy-path: Provisioned→Pending→Active through two consecutive transitions',
    async () => {
      const { store, ctrl } = buildStack(0); // 0% failure — force all commits
      const nodeId = 'node-fullpath';
      store.nodes.set(nodeId, { node_id: nodeId, status: 'Provisioned' });

      const r1 = await ctrl.transition(nodeId, 'Pending');
      assert.equal(r1.committed, true);
      assert.equal(store.nodes.get(nodeId)!.status, 'Pending');

      const r2 = await ctrl.transition(nodeId, 'Active');
      assert.equal(r2.committed, true);
      assert.equal(store.nodes.get(nodeId)!.status, 'Active');
    },
  );

  // ── Test 15: Commit-path DB failure → FATAL marker, no auto-rollback ──────
  await test(
    'Commit-path DB failure returns committed=false and marks tentative for admin resolution',
    async () => {
      // Build a store whose transaction() always throws to simulate DB crash
      const store = new FakeStore();
      let txCallCount = 0;
      const originalTx = store.transaction.bind(store);
      store.transaction = async <T>(fn: (client: any) => Promise<T>): Promise<T> => {
        txCallCount++;
        throw new Error('Simulated DB crash');
      };

      const rpc     = new FakeRpc(0); // 0% contract failure — on-chain succeeds
      const handler = new RollbackHandler(store);
      const ctrl    = new TwoPhaseController(store, rpc, handler, 'CONTRACT_TEST');

      const nodeId = 'node-commit-fail';
      store.nodes.set(nodeId, { node_id: nodeId, status: 'Provisioned' });

      const result = await ctrl.transition(nodeId, 'Pending');

      // On-chain succeeded but DB commit failed — should NOT be marked committed
      assert.equal(result.committed, false);
      assert.equal(result.rolledBack, false); // NOT rolled back either

      // node_status must remain unchanged (Provisioned)
      assert.equal(store.nodes.get(nodeId)!.status, 'Provisioned');

      // Tentative row should have the COMMIT_FAILED marker
      const t = store.tentatives.get(nodeId);
      assert.ok(t !== undefined);
      assert.ok(
        t!.error_detail?.includes('COMMIT_FAILED'),
        `Expected COMMIT_FAILED marker, got: ${t!.error_detail}`,
      );

      // DB transaction was attempted COMMIT_RETRY_ATTEMPTS (2) times
      assert.equal(txCallCount, 2, `Expected 2 retry attempts, got ${txCallCount}`);
    },
  );

  // ── Test 16: TOCTOU race — atomic Phase-1 guard ───────────────────────────
  await test(
    'Atomic Phase-1 INSERT rejects concurrent transition when PENDING row is live',
    async () => {
      const { store, ctrl } = buildStack(0);
      const nodeId = 'node-race';
      store.nodes.set(nodeId, { node_id: nodeId, status: 'Provisioned' });

      // First transition succeeds — creates a PENDING tentative row.
      // But we pre-seed a PENDING row to simulate the race condition:
      // "another caller already wrote Phase 1 before we got here"
      store.tentatives.set(nodeId, {
        node_id: nodeId, target_status: 'Pending',
        idempotency_key: 'idem-race-winner', state: 'PENDING',
        created_at: new Date(), expires_at: new Date(Date.now() + 25_000),
      });

      // Second transition must be rejected by the atomic INSERT guard
      await assert.rejects(
        () => ctrl.transition(nodeId, 'Pending'),
        /already has a PENDING tentative/,
      );

      // The original PENDING row must NOT have been overwritten
      assert.equal(store.tentatives.get(nodeId)!.idempotency_key, 'idem-race-winner');
      assert.equal(store.nodes.get(nodeId)!.status, 'Provisioned');
    },
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────');
  if (failed === 0) {
    console.log(`  ✓ All ${passed} tests passed`);
  } else {
    console.log(`  ${passed} passed, ${failed} failed`);
    for (const f of failures) console.log(f);
  }
  console.log('──────────────────────────────────────────\n');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unhandled error in test runner:', err);
  process.exit(1);
});
