import { createLogger } from '../../diagnostics/logger';
import { RollbackHandler, RollbackDb } from './rollback_handler';

// ── DB interface ──────────────────────────────────────────────────────────────

export interface CleanupDb extends RollbackDb {
  query<T extends Record<string, any> = any>(
    sql: string,
    params?: any[],
    opts?: { tier?: 'oltp' | 'olap' },
  ): Promise<{ rows: T[]; rowCount: number }>;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface CleanupWorkerConfig {
  /** How often to sweep expired rows (ms). Default: 5 000. */
  intervalMs?: number;
  /** Max rows to process per sweep tick (guards against burst catch-up). */
  batchSize?: number;
}

// ── Metrics snapshot ──────────────────────────────────────────────────────────

export interface CleanupWorkerMetrics {
  /** Total rollbacks performed since process start. Maps to two_phase_rollbacks_total. */
  rollbacksTotal: number;
  /** Number of sweep iterations executed. */
  sweepsTotal: number;
  /** Rows found expired but skipped because another instance claimed them first. */
  skippedTotal: number;
  /** Last sweep timestamp (Unix ms), 0 if never run. */
  lastSweepAt: number;
}

// ── TentativeCleanupWorker ────────────────────────────────────────────────────

/**
 * Background worker that sweeps expired PENDING tentative rows and triggers
 * a full rollback for each via `RollbackHandler.execute()`.
 *
 * Design choices:
 *
 *   NO COORDINATOR LOCK (SPOF-free)
 *   ─────────────────────────────────
 *   Multiple instances of this worker can run concurrently in different Node.js
 *   processes (e.g. Kubernetes replicas).  Race safety is provided by
 *   `FOR UPDATE SKIP LOCKED` at the SELECT level and the atomic
 *   `UPDATE WHERE state = 'PENDING'` compare-and-swap inside
 *   `RollbackHandler.execute()`.  If two workers claim the same row in the
 *   same millisecond:
 *     - Worker A wins the row lock: performs rollback, commits.
 *     - Worker B's SKIP LOCKED SELECT skips the locked row entirely.
 *
 *   TTL CONTRACT
 *   ─────────────
 *   Rows expire after 30 s (one Soroban ledger confirmation cycle).  The sweep
 *   interval (default 5 s) guarantees at most 35 s of divergence between a
 *   Phase-2 crash and rollback completion.
 *
 *   METRICS
 *   ────────
 *   `rollbacksTotal` mirrors the Prometheus counter `two_phase_rollbacks_total`.
 *   The structured log line emitted by `RollbackHandler` carries the same field,
 *   making it observable via both push (Prometheus scrape) and pull (log grep).
 */
export class TentativeCleanupWorker {
  private readonly log = createLogger('tentative_cleanup_worker');
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly metrics: CleanupWorkerMetrics = {
    rollbacksTotal: 0,
    sweepsTotal:    0,
    skippedTotal:   0,
    lastSweepAt:    0,
  };

  constructor(
    private readonly db: CleanupDb,
    private readonly rollbackHandler: RollbackHandler,
    config?: CleanupWorkerConfig,
  ) {
    this.intervalMs = config?.intervalMs ?? 5_000;
    this.batchSize  = config?.batchSize  ?? 50;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer !== null) return; // idempotent
    this.timer = setInterval(
      () => this.sweep().catch((err) =>
        this.log.error('Sweep tick failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
      this.intervalMs,
    );
    this.log.info('TentativeCleanupWorker started', {
      interval_ms: this.intervalMs,
      batch_size:  this.batchSize,
    });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.info('TentativeCleanupWorker stopped');
    }
  }

  getMetrics(): Readonly<CleanupWorkerMetrics> {
    return { ...this.metrics };
  }

  /** Expose Prometheus text format for the /metrics scrape endpoint. */
  prometheusMetrics(): string {
    const m = this.metrics;
    return [
      '# HELP two_phase_rollbacks_total Total node status rollbacks due to Phase-2 contract failures or TTL expiry',
      '# TYPE two_phase_rollbacks_total counter',
      `two_phase_rollbacks_total ${m.rollbacksTotal}`,
      '',
      '# HELP two_phase_sweep_total Total cleanup sweep iterations executed',
      '# TYPE two_phase_sweep_total counter',
      `two_phase_sweep_total ${m.sweepsTotal}`,
      '',
      '# HELP two_phase_sweep_last_at_seconds Unix timestamp of last sweep',
      '# TYPE two_phase_sweep_last_at_seconds gauge',
      `two_phase_sweep_last_at_seconds ${(m.lastSweepAt / 1000).toFixed(3)}`,
      '',
    ].join('\n');
  }

  // ── Sweep logic ─────────────────────────────────────────────────────────────

  /**
   * One sweep tick.  Called automatically by the interval timer; also safe to
   * call manually in tests or from an admin endpoint to trigger an immediate sweep.
   */
  async sweep(): Promise<{ processed: number; skipped: number }> {
    this.metrics.sweepsTotal++;
    this.metrics.lastSweepAt = Date.now();

    // Claim expired PENDING rows atomically using FOR UPDATE SKIP LOCKED.
    // This is the SPOF-free distributed mutex: only one worker acquires each
    // row's lock, other workers transparently skip that row.
    //
    // We read inside the OLTP pool (short statements; row-level locks needed).
    const claimed = await this.db.query<{
      node_id:         string;
      idempotency_key: string;
      target_status:   string;
    }>(
      `SELECT node_id, idempotency_key, target_status
         FROM node_status_tentative
        WHERE state     = 'PENDING'
          AND expires_at < NOW()
          AND (error_detail IS NULL OR error_detail NOT LIKE 'COMMIT_FAILED%')
        ORDER BY expires_at ASC       -- oldest first; prevents starvation
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [this.batchSize],
      { tier: 'oltp' },
    );

    if (claimed.rows.length === 0) return { processed: 0, skipped: 0 };

    this.log.info('Sweep: found expired tentative rows', { count: claimed.rows.length });

    let processed = 0;
    let skipped   = 0;

    for (const row of claimed.rows) {
      // RollbackHandler.execute() is the "compare-and-swap" second guard.
      // It UPDATEs WHERE state = 'PENDING' and returns { claimed: false } if
      // another instance already handled the row between our SELECT and now.
      const result = await this.rollbackHandler.execute(
        row.node_id,
        row.idempotency_key,
        row.target_status,
        'Expired without on-chain confirmation (TentativeCleanupWorker sweep)',
      );

      if (result.claimed) {
        this.metrics.rollbacksTotal++;
        processed++;
      } else {
        this.metrics.skippedTotal++;
        skipped++;
      }
    }

    if (processed > 0) {
      this.log.warn('Sweep complete: rolled back expired tentative rows', {
        processed,
        skipped,
        two_phase_rollbacks_total: this.metrics.rollbacksTotal,
      });
    }

    return { processed, skipped };
  }
}
