import { createLogger } from '../../diagnostics/logger';

// ── Minimal DB interfaces ─────────────────────────────────────────────────────
// Typed narrow enough that the fake DB in tests satisfies them without friction.

export interface TransactionClient {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount: number }>;
}

export interface RollbackDb {
  transaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T>;
}

// ── RollbackHandler ───────────────────────────────────────────────────────────

/**
 * Executes a coordinated rollback when Phase 2 (Soroban contract call) fails.
 *
 * Cascade order is designed around FK dependencies and the requirement that
 * the main `node_status` table is NEVER touched — it retains the last committed
 * status, which is the desired invariant after a Phase-2 failure.
 *
 * Operations performed inside a single ACID transaction:
 *   1. Mark the tentative row ROLLED_BACK (idempotent; skips if already done).
 *   2. Append to two_phase_rollback_log (immutable audit trail).
 *   3. Delete speculative reward_tx rows created in the tentative window.
 *   4. Delete speculative node_attestations rows that referenced the uncommitted status.
 *   5. Revert speculative reputation_adjustments tagged with the idempotency_key.
 *
 * All UPDATEs / DELETEs use IF-EXISTS / conditional WHERE so re-running on a
 * partially applied rollback (crash-recovery) is safe.
 */
export class RollbackHandler {
  private readonly log = createLogger('rollback_handler');

  constructor(private readonly db: RollbackDb) {}

  async execute(
    nodeId: string,
    idempotencyKey: string,
    targetStatus: string,
    reason: string,
  ): Promise<{ claimed: boolean }> {
    let claimed = false;

    await this.db.transaction(async (client) => {
      // ── Step 1: Claim the tentative row ─────────────────────────────────
      // The UPDATE only matches when state = 'PENDING', making this operation
      // the atomic "compare-and-swap" that prevents double-rollback when two
      // workers race (e.g., cleanup worker + in-flight Phase-2 failure handler).
      const claimResult = await client.query(
        `UPDATE node_status_tentative
            SET state        = 'ROLLED_BACK',
                error_detail = $1,
                resolved_at  = NOW()
          WHERE node_id = $2
            AND state   = 'PENDING'`,
        [reason, nodeId],
      );

      // Another instance already handled this rollback — nothing further to do.
      if ((claimResult.rowCount ?? 0) === 0) {
        this.log.info('Rollback skipped: tentative row already resolved', {
          node_id: nodeId,
          idempotency_key: idempotencyKey,
        });
        return;
      }

      claimed = true;

      // ── Step 2: Persist rollback incident ────────────────────────────────
      // Immutable audit row. Feeds the two_phase_rollbacks_total metric and
      // the two_phase_rollback_totals operator view.
      await client.query(
        `INSERT INTO two_phase_rollback_log
           (node_id, idempotency_key, target_status, failure_reason)
         VALUES ($1, $2, $3, $4)`,
        [nodeId, idempotencyKey, targetStatus, reason],
      );

      // ── Step 3: Cascade — reward_tx ─────────────────────────────────────
      // Delete any reward_tx rows written speculatively against the tentative
      // window. They are identified by node_id + creation timestamp.  If no
      // reward_tx rows exist (node never had a reward in flight), this is a
      // no-op.
      await client.query(
        `DELETE FROM reward_tx
          WHERE node_id   = $1
            AND created_at >= (
              SELECT created_at
              FROM   node_status_tentative
              WHERE  node_id = $1
            )`,
        [nodeId],
      );

      // ── Step 4: Cascade — node_attestations ─────────────────────────────
      // Delete attestation records that already embedded the uncommitted
      // target_status.  The tentative window created_at timestamp bounds
      // which rows are speculative.
      await client.query(
        `DELETE FROM node_attestations
          WHERE node_id        = $1
            AND attested_status = $2
            AND created_at     >= (
              SELECT created_at
              FROM   node_status_tentative
              WHERE  node_id = $1
            )`,
        [nodeId, targetStatus],
      );

      // ── Step 5: Cascade — reputations ────────────────────────────────────
      // Revert any speculative reputation_adjustments tagged with this exact
      // idempotency_key.  score and slash_version are restored atomically so
      // no read-modify-write race is possible.
      //
      // Subquery aggregates are 0 when no speculative adjustments exist,
      // making this step a safe no-op for nodes without in-flight reputation
      // changes.
      await client.query(
        `UPDATE reputations
            SET score         = GREATEST(-1000, LEAST(1000,
                                  score - COALESCE((
                                    SELECT SUM(delta)
                                    FROM   reputation_adjustments
                                    WHERE  node_id         = $1
                                      AND  idempotency_key = $2
                                  ), 0)
                                )),
                slash_version = slash_version - COALESCE((
                                  SELECT COUNT(*)
                                  FROM   reputation_adjustments
                                  WHERE  node_id         = $1
                                    AND  idempotency_key = $2
                                    AND  is_slash        = TRUE
                                ), 0),
                updated_at    = NOW()
          WHERE node_id = $1`,
        [nodeId, idempotencyKey],
      );

      // Clean up the speculative adjustment rows now that we've reverted them.
      await client.query(
        `DELETE FROM reputation_adjustments
          WHERE node_id         = $1
            AND idempotency_key = $2`,
        [nodeId, idempotencyKey],
      );
    });

    if (claimed) {
      this.log.warn('Rollback executed: Phase-2 failure cascaded to dependent tables', {
        node_id: nodeId,
        idempotency_key: idempotencyKey,
        target_status: targetStatus,
        reason,
        // Increment signal picked up by the Prometheus scraper via structured log.
        two_phase_rollbacks_total: 1,
      });
    }

    return { claimed };
  }
}
