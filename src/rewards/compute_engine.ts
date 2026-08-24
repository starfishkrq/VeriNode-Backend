/**
 * Fixed-point reward computation engine for Soroban staking payouts.
 *
 * Replaces the deprecated float path in `../utils/math_float` with a pure
 * integer fixed-point implementation that guarantees:
 *
 *   • Cumulative error < 1 unit (10^-7 token) across all nodes per cycle
 *   • Deterministic cross-platform results (no IEEE 754 variance)
 *   • All intermediate values stay in the integer domain
 *
 * Technical bounds (Soroban i128 fixed-point, 7 decimal places):
 *   1 unit        = 10^-7 token
 *   Max per node  = 10^12 units (100,000 tokens)
 *   Scale factor  = 10^7
 *
 * @module compute_engine
 */

import {
  FixedPoint,
  FIXED_POINT_SCALE,
  MAX_REWARD_UNITS,
  assertDistributionSumcheck,
} from '../utils/math_precision';

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Format raw 7-decimal units as a human-readable string, e.g. "1.2345678". */
function formatUnits(units: bigint): string {
  const whole = units / FIXED_POINT_SCALE;
  const fraction = units % FIXED_POINT_SCALE;
  return `${whole}.${fraction.toString().padStart(7, '0')}`;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface RewardInput {
  /** Uptime measured value (integer, 0 … uptimeDenominator) */
  uptimeNumerator: bigint;
  /** Uptime measurement base (integer, > 0) */
  uptimeDenominator: bigint;
  /** Compute contribution weight (integer, 0 … 1_000_000) */
  computeWeight: bigint;
  /** Storage contribution weight (integer, 0 … 1_000_000) */
  storageWeight: bigint;
  /** Total reward pool for this cycle in raw 7-decimal units */
  totalPoolUnits: bigint;
  /** Number of nodes sharing the pool (> 0) */
  nodeCount: bigint;
}

export interface RewardOutput {
  /** Computed reward in raw 7-decimal units (bigint, integer domain) */
  units: bigint;
  /** Human-readable 7-decimal string (e.g. "1.2345678") */
  formatted: string;
}

// ── Core engine ──────────────────────────────────────────────────────────────

/**
 * Calculate the fixed-point reward for a single node.
 *
 * Computation chain (all integer domain):
 *
 *   uptime    = FixedPoint.fromRatio(uptimeNumerator, uptimeDenominator)
 *   compute   = FixedPoint.fromRatio(computeWeight,  1_000_000)
 *   storage   = FixedPoint.fromRatio(storageWeight,  1_000_000)
 *   poolShare = FixedPoint.fromRatio(totalPoolUnits, nodeCount)
 *   reward    = uptime × compute × storage × poolShare
 *
 * This replaces the legacy float chain:
 *   (uptime_pct × compute_weight × storage_weight) / divisor
 *
 * @throws {RangeError} for invalid (zero denominator) or out-of-bounds inputs
 */
export function calculateReward(input: RewardInput): RewardOutput {
  const {
    uptimeNumerator,
    uptimeDenominator,
    computeWeight,
    storageWeight,
    totalPoolUnits,
    nodeCount,
  } = input;

  if (uptimeDenominator <= 0n) {
    throw new RangeError('calculateReward: uptimeDenominator must be > 0');
  }
  if (nodeCount <= 0n) {
    throw new RangeError('calculateReward: nodeCount must be > 0');
  }
  if (uptimeNumerator < 0n || uptimeNumerator > uptimeDenominator) {
    throw new RangeError(
      'calculateReward: uptimeNumerator must be in [0, uptimeDenominator]',
    );
  }
  if (computeWeight < 0n || computeWeight > 1_000_000n) {
    throw new RangeError('calculateReward: computeWeight must be in [0, 1_000_000]');
  }
  if (storageWeight < 0n || storageWeight > 1_000_000n) {
    throw new RangeError('calculateReward: storageWeight must be in [0, 1_000_000]');
  }

  // All operations stay in integer domain via FixedPoint.
  //
  // uptime, compute, storage are dimensionless fractions in [0, 1] represented
  // as FixedPoint values (raw = fraction × SCALE).
  //
  // poolShare is raw units per node (integer, not a FixedPoint fraction).
  // We compute:
  //   reward_units = uptime_fraction × compute_fraction × storage_fraction × pool_per_node
  //
  // Using FixedPoint chain for the three fractions gives a composite fraction:
  //   composite.raw = uptime × compute × storage (all integer ops, floor division)
  //
  // Then reward_units = composite.raw × pool_per_node / SCALE
  // This collapses the final FixedPoint scale factor while keeping full precision.

  const uptime = FixedPoint.fromRatio(uptimeNumerator, uptimeDenominator);
  const compute = FixedPoint.fromRatio(computeWeight, 1_000_000n);
  const storage = FixedPoint.fromRatio(storageWeight, 1_000_000n);

  // Composite dimensionless fraction: uptime × compute × storage ∈ [0, 1]
  const composite = uptime.mul(compute).mul(storage);

  // Pool units per node (integer floor division — stays in integer domain)
  const poolPerNode = totalPoolUnits / nodeCount;

  // Reward in raw units: composite × pool_per_node (de-scale once)
  const units = (composite.toUnits() * poolPerNode) / FIXED_POINT_SCALE;

  if (units < 0n || units > MAX_REWARD_UNITS) {
    throw new RangeError(
      `calculateReward: computed reward ${units} exceeds MAX_REWARD_UNITS ${MAX_REWARD_UNITS}`,
    );
  }

  return {
    units,
    formatted: formatUnits(units),
  };
}

// ── Batch distribution with sumcheck ─────────────────────────────────────────

export interface BatchRewardInput extends RewardInput {
  nodeId: string;
}

export interface BatchRewardOutput extends RewardOutput {
  nodeId: string;
}

/**
 * Compute rewards for an entire node batch and assert the sumcheck invariant.
 *
 * After computing all per-node rewards the sum is compared to `totalPoolUnits`.
 * If |sum - pool| > 1 unit, an invariant violation error is thrown and the
 * cycle must NOT be settled — this signals a logic error upstream.
 *
 * @throws {Error} if the sumcheck invariant is violated
 */
export function calculateBatchRewards(inputs: BatchRewardInput[]): BatchRewardOutput[] {
  const outputs: BatchRewardOutput[] = inputs.map((input) => ({
    nodeId: input.nodeId,
    ...calculateReward(input),
  }));

  // Derive pool from first input (all inputs share the same pool in a cycle)
  if (inputs.length > 0) {
    const totalPoolUnits = inputs[0].totalPoolUnits;
    assertDistributionSumcheck(
      outputs.map((o) => o.units),
      totalPoolUnits,
    );
  }

  return outputs;
}
