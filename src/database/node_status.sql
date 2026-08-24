-- src/database/node_status.sql

-- Primary table for committed node status
CREATE TABLE IF NOT EXISTS node_status (
    node_id VARCHAR(255) PRIMARY KEY,
    status VARCHAR(64) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tentative table for two-phase commit status transitions
CREATE TABLE IF NOT EXISTS node_status_tentative (
    node_id VARCHAR(255) PRIMARY KEY,
    target_status VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    state VARCHAR(16) DEFAULT 'PENDING',
    error_detail TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_node FOREIGN KEY (node_id) REFERENCES node_status(node_id) ON DELETE CASCADE
);

-- Index for background cleanup worker
CREATE INDEX IF NOT EXISTS idx_node_status_tentative_expires 
ON node_status_tentative (expires_at) 
WHERE state = 'PENDING';

-- Immutable audit log for two-phase commit rollbacks
CREATE TABLE IF NOT EXISTS two_phase_rollback_log (
    id SERIAL PRIMARY KEY,
    node_id VARCHAR(255) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    target_status VARCHAR(64) NOT NULL,
    failure_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Speculative tables for cascading rollbacks
CREATE TABLE IF NOT EXISTS reward_tx (
    id SERIAL PRIMARY KEY,
    node_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS node_attestations (
    id SERIAL PRIMARY KEY,
    node_id VARCHAR(255) NOT NULL,
    attested_status VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reputations (
    node_id VARCHAR(255) PRIMARY KEY,
    score NUMERIC DEFAULT 100,
    slash_version INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reputation_adjustments (
    id SERIAL PRIMARY KEY,
    node_id VARCHAR(255) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    delta NUMERIC NOT NULL,
    is_slash BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indexes for cascading rollback queries
-- RollbackHandler deletes from reward_tx WHERE node_id = $1 AND created_at >= ...
CREATE INDEX IF NOT EXISTS idx_reward_tx_node_id
ON reward_tx (node_id, created_at);

-- RollbackHandler deletes from node_attestations WHERE node_id = $1 AND attested_status = $2 AND created_at >= ...
CREATE INDEX IF NOT EXISTS idx_node_attestations_node_status
ON node_attestations (node_id, attested_status, created_at);

-- RollbackHandler reverts reputation_adjustments WHERE node_id = $1 AND idempotency_key = $2
CREATE INDEX IF NOT EXISTS idx_reputation_adjustments_node_key
ON reputation_adjustments (node_id, idempotency_key);

-- Rollback log query by node for admin dashboards
CREATE INDEX IF NOT EXISTS idx_rollback_log_node_id
ON two_phase_rollback_log (node_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- NOTE: The previous pg_cron cleanup function was REMOVED because it only marked
-- tentative rows as ROLLED_BACK without cascading to dependent tables (reward_tx,
-- node_attestations, reputation_adjustments).  This created silent data corruption
-- when pg_cron fired before the Node.js TentativeCleanupWorker.
--
-- Cleanup is now handled exclusively by TentativeCleanupWorker (Node.js), which:
--   1. Uses FOR UPDATE SKIP LOCKED for SPOF-free distributed cleanup
--   2. Delegates to RollbackHandler.execute() for full cascade rollback
--   3. Emits Prometheus metrics for observability
--
-- If you need a database-level safety net, use the function below which calls
-- the full cascade.  However, this requires the rollback cascade to be
-- reimplemented in PL/pgSQL, which duplicates logic.  Prefer the Node.js worker.
-- ═══════════════════════════════════════════════════════════════════════════════
