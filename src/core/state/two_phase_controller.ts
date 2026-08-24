import { createHash, randomUUID } from 'crypto';
import { createLogger } from '../../diagnostics/logger';
import { RollbackHandler, RollbackDb, TransactionClient } from './rollback_handler';

const COMMIT_RETRY_ATTEMPTS = 2;
const COMMIT_RETRY_DELAY_MS = 500;

// ── State machine types ───────────────────────────────────────────────────────

export type NodeStatus =
  | 'Provisioned'
  | 'Pending'
  | 'Active'
  | 'Slashed'
  | 'Archived';

/** Directed edges of the node status state machine. */
const VALID_TRANSITIONS: Readonly<Record<NodeStatus, readonly NodeStatus[]>> = {
  Provisioned: ['Pending'],
  Pending:     ['Active'],
  Active:      ['Slashed', 'Archived'],
  Slashed:     ['Archived'],
  Archived:    [],
};

// ── DB interfaces ─────────────────────────────────────────────────────────────

export interface QueryOpts {
  tier?: 'oltp' | 'olap';
}

export interface QueryDb {
  query<T extends Record<string, any> = any>(
    sql: string,
    params?: any[],
    opts?: QueryOpts,
  ): Promise<{ rows: T[]; rowCount: number }>;
}


export type TwoPhaseDb = QueryDb & RollbackDb;

// ── RPC client interface ──────────────────────────────────────────────────────

export interface ContractCallResult {
  hash: string;
  success: boolean;
  error?: { code: number; message: string };
}

export interface LedgerInfoResult {
  latestLedger: string;
  error?: { code: number; message: string };
}

export interface SorobanRpc {
  sendTransaction(txEnvelope: string): Promise<ContractCallResult>;
  simulateTransaction(txEnvelope: string): Promise<LedgerInfoResult>;
}

// ── Public result types ───────────────────────────────────────────────────────

export interface NodeStatusRecord {
  nodeId: string;
  status: NodeStatus;
  tentative: false;
}

export interface TentativeStatusRecord {
  nodeId: string;
  status: NodeStatus;
  tentative: true;
  idempotencyKey: string;
  expiresAt: Date;
}

export type GetStatusResult = NodeStatusRecord | TentativeStatusRecord;

export interface TransitionResult {
  nodeId: string;
  previousStatus: NodeStatus;
  targetStatus: NodeStatus;
  idempotencyKey: string;
  txHash: string | null;
  committed: boolean;
  rolledBack: boolean;
}

export interface ResolveTentativeResult {
  resolved: boolean;
  outcome: 'committed' | 'rolled_back' | 'no_pending_row';
}


export class TwoPhaseController {
  private readonly log = createLogger('two_phase_controller');

  constructor(
    private readonly db: TwoPhaseDb,
    private readonly rpc: SorobanRpc,
    private readonly rollbackHandler: RollbackHandler,
    private readonly contractId: string,
  ) {}

  /** SHA256(node_id + ":" + ledger_sequence + ":" + nonce) */
  static buildIdempotencyKey(
    nodeId: string,
    ledgerSequence: number,
    nonce: string,
  ): string {
    return createHash('sha256')
      .update(`${nodeId}:${ledgerSequence}:${nonce}`)
      .digest('hex');
  }


  async transition(nodeId: string, targetStatus: NodeStatus): Promise<TransitionResult> {

    const currentStatus = await this.fetchCommittedStatus(nodeId);
    if (currentStatus === null) {
      throw new Error(
        `[TwoPhaseController] Node "${nodeId}" not found in node_status.`,
      );
    }

    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed.includes(targetStatus)) {
      throw new Error(
        `[TwoPhaseController] Illegal transition ${currentStatus} → ${targetStatus} ` +
          `for node "${nodeId}". Allowed: [${allowed.join(', ')}]`,
      );
    }


    const ledgerSequence = await this.fetchLedgerSequence();
    const nonce = createHash('sha256').update(randomUUID()).digest('hex').slice(0, 16);
    const idempotencyKey = TwoPhaseController.buildIdempotencyKey(
      nodeId, ledgerSequence, nonce,
    );

    this.log.info('Starting two-phase transition', {
      node_id:         nodeId,
      from:            currentStatus,
      to:              targetStatus,
      idempotency_key: idempotencyKey,
      ledger_sequence: ledgerSequence,
    });

    // PHASE 1 — Atomic INSERT with WHERE NOT EXISTS guard against live PENDING rows.
    const phase1Result = await this.db.query(
      `INSERT INTO node_status_tentative
         (node_id, target_status, idempotency_key, state, expires_at)
       SELECT $1, $2, $3, 'PENDING', NOW() + INTERVAL '30 seconds'
       WHERE NOT EXISTS (
         SELECT 1 FROM node_status_tentative
         WHERE node_id = $1 AND state = 'PENDING'
       )
       ON CONFLICT (node_id) DO UPDATE
         SET target_status   = EXCLUDED.target_status,
             idempotency_key = EXCLUDED.idempotency_key,
             state           = 'PENDING',
             error_detail    = NULL,
             resolved_at     = NULL,
             created_at      = NOW(),
             expires_at      = NOW() + INTERVAL '30 seconds'
         WHERE node_status_tentative.state <> 'PENDING'`,
      [nodeId, targetStatus, idempotencyKey],
      { tier: 'oltp' },
    );


    if ((phase1Result.rowCount ?? 0) === 0) {

      const existing = await this.fetchTentativeRow(nodeId);
      const expiresIn = existing
        ? Math.max(0, Math.round((existing.expires_at.getTime() - Date.now()) / 1000))
        : 0;
      throw new Error(
        `[TwoPhaseController] Node "${nodeId}" already has a PENDING tentative ` +
          `transition to "${existing?.target_status ?? '?'}" ` +
          `(key=${existing?.idempotency_key ?? '?'}, expires in ~${expiresIn}s). ` +
          `Wait for TTL expiry or call resolveTentative().`,
      );
    }

    this.log.info('Phase 1 complete: tentative record written', {
      node_id: nodeId, idempotency_key: idempotencyKey,
    });

    // PHASE 2 — Soroban contract call.
    let txHash: string | null = null;
    let contractError: string | undefined;

    try {
      const txEnvelope = this.encodeStatusTransitionTx(
        nodeId, targetStatus, idempotencyKey, ledgerSequence,
      );
      const result = await this.rpc.sendTransaction(txEnvelope);

      if (result.success) {
        txHash = result.hash;
        this.log.info('Phase 2 complete: Soroban call confirmed', {
          node_id: nodeId, tx_hash: txHash, idempotency_key: idempotencyKey,
        });
      } else {
        contractError = result.error?.message ?? 'Contract rejected the transaction';
        this.log.warn('Phase 2 failed: contract error', {
          node_id: nodeId, error: contractError, idempotency_key: idempotencyKey,
        });
      }
    } catch (err) {
      contractError =
        err instanceof Error ? err.message : 'RPC threw unexpectedly';
      this.log.error('Phase 2 failed: RPC exception', {
        node_id: nodeId, error: contractError, idempotency_key: idempotencyKey,
      });
    }

    // COMMIT PATH — retry on DB failure to prevent on-chain/local divergence.
    if (contractError === undefined) {
      let commitSuccess = false;

      for (let attempt = 1; attempt <= COMMIT_RETRY_ATTEMPTS; attempt++) {
        try {
          await this.db.transaction(async (client: TransactionClient) => {
            await client.query(
              `UPDATE node_status
                  SET status     = $1,
                      updated_at = NOW()
                WHERE node_id = $2`,
              [targetStatus, nodeId],
            );
            await client.query(
              `UPDATE node_status_tentative
                  SET state       = 'COMMITTED',
                      resolved_at = NOW()
                WHERE node_id = $1`,
              [nodeId],
            );
          });
          commitSuccess = true;
          break;
        } catch (dbErr) {
          const errMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          this.log.error(`Commit-path DB transaction failed (attempt ${attempt}/${COMMIT_RETRY_ATTEMPTS})`, {
            node_id: nodeId, idempotency_key: idempotencyKey, error: errMsg,
          });
          if (attempt < COMMIT_RETRY_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, COMMIT_RETRY_DELAY_MS));
          }
        }
      }

      if (commitSuccess) {
        this.log.info('Transition committed: node_status updated', {
          node_id: nodeId, from: currentStatus, to: targetStatus,
        });

        return {
          nodeId,
          previousStatus: currentStatus,
          targetStatus,
          idempotencyKey,
          txHash,
          committed: true,
          rolledBack: false,
        };
      }

      // Retries exhausted. Mark row so cleanup worker skips it; requires admin resolution.
      this.log.error(
        'FATAL: Commit-path exhausted all retries. On-chain state is committed ' +
          'but local DB is NOT updated. Requires manual resolveTentative("commit").',
        {
          node_id: nodeId,
          idempotency_key: idempotencyKey,
          tx_hash: txHash,
          target_status: targetStatus,
        },
      );


      try {
        await this.db.query(
          `UPDATE node_status_tentative
              SET error_detail = 'COMMIT_FAILED_ONCHAIN_CONFIRMED: requires admin resolveTentative(commit)'
            WHERE node_id = $1 AND state = 'PENDING'`,
          [nodeId],
          { tier: 'oltp' },
        );
      } catch { /* best-effort; already logged FATAL */ }


      return {
        nodeId,
        previousStatus: currentStatus,
        targetStatus,
        idempotencyKey,
        txHash,
        committed: false,
        rolledBack: false,
      };
    }

    // ROLLBACK PATH — node_status is NOT touched; retains currentStatus.
    await this.rollbackHandler.execute(
      nodeId, idempotencyKey, targetStatus, contractError,
    );

    return {
      nodeId,
      previousStatus: currentStatus,
      targetStatus,
      idempotencyKey,
      txHash: null,
      committed: false,
      rolledBack: true,
    };
  }

  /** Returns effective status; checks tentative table first. */
  async getNodeStatus(nodeId: string): Promise<GetStatusResult | null> {

    const tentativeRow = await this.db.query<{
      target_status: string;
      idempotency_key: string;
      expires_at: Date;
    }>(
      `SELECT target_status, idempotency_key, expires_at
         FROM node_status_tentative
        WHERE node_id   = $1
          AND state     = 'PENDING'
          AND expires_at > NOW()`,
      [nodeId],
      { tier: 'oltp' },
    );

    if (tentativeRow.rows.length > 0) {
      const t = tentativeRow.rows[0];
      return {
        nodeId,
        status:         t.target_status as NodeStatus,
        tentative:      true,
        idempotencyKey: t.idempotency_key,
        expiresAt:      t.expires_at,
      };
    }


    const committed = await this.fetchCommittedStatus(nodeId);
    if (committed === null) return null;
    return { nodeId, status: committed, tentative: false };
  }

  /** Force-resolve a stuck PENDING tentative row. */
  async resolveTentative(
    nodeId: string,
    resolution: 'commit' | 'rollback',
  ): Promise<ResolveTentativeResult> {
    const row = await this.fetchTentativeRow(nodeId);

    if (!row || row.state !== 'PENDING') {
      this.log.info('resolveTentative: no PENDING row found', { node_id: nodeId });
      return { resolved: false, outcome: 'no_pending_row' };
    }

    if (resolution === 'commit') {
      await this.db.transaction(async (client: TransactionClient) => {
        await client.query(
          `UPDATE node_status
              SET status     = $1,
                  updated_at = NOW()
            WHERE node_id = $2`,
          [row.target_status, nodeId],
        );
        await client.query(
          `UPDATE node_status_tentative
              SET state       = 'COMMITTED',
                  resolved_at = NOW(),
                  error_detail = 'Admin force-commit'
            WHERE node_id = $1`,
          [nodeId],
        );
      });
      this.log.warn('Admin force-committed tentative row', {
        node_id: nodeId, target_status: row.target_status,
      });
      return { resolved: true, outcome: 'committed' };
    }


    await this.rollbackHandler.execute(
      nodeId,
      row.idempotency_key,
      row.target_status,
      'Admin force-rollback via /internal/state/resolve-tentative',
    );
    return { resolved: true, outcome: 'rolled_back' };
  }



  private async fetchCommittedStatus(nodeId: string): Promise<NodeStatus | null> {
    const result = await this.db.query<{ status: string }>(
      `SELECT status FROM node_status WHERE node_id = $1`,
      [nodeId],
      { tier: 'oltp' },
    );
    return result.rows.length > 0 ? (result.rows[0].status as NodeStatus) : null;
  }

  private async fetchTentativeRow(nodeId: string): Promise<{
    target_status: string;
    idempotency_key: string;
    state: string;
    expires_at: Date;
  } | null> {
    const result = await this.db.query<{
      target_status:   string;
      idempotency_key: string;
      state:           string;
      expires_at:      Date;
    }>(
      `SELECT target_status, idempotency_key, state, expires_at
         FROM node_status_tentative
        WHERE node_id = $1`,
      [nodeId],
      { tier: 'oltp' },
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /** Fetch ledger sequence from Soroban RPC. Defaults to 0 on failure. */
  private async fetchLedgerSequence(): Promise<number> {
    try {
      const probe = Buffer.from(JSON.stringify({ op: 'ping' })).toString('base64');
      const resp = await this.rpc.simulateTransaction(probe);
      const seq = parseInt(resp.latestLedger, 10);
      return Number.isFinite(seq) ? seq : 0;
    } catch {
      return 0;
    }
  }


  private encodeStatusTransitionTx(
    nodeId:          string,
    targetStatus:    NodeStatus,
    idempotencyKey:  string,
    ledgerSequence:  number,
  ): string {
    const envelope = {
      op:             'invoke_contract',
      contractId:     this.contractId,
      fn:             'update_node_status',
      args:           { node_id: nodeId, target_status: targetStatus },
      memo:           idempotencyKey,
      ledgerSequence,
    };
    return Buffer.from(JSON.stringify(envelope)).toString('base64');
  }
}
