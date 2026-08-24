/**
 * Fixed-point weight aggregation for staking reward calculations.
 *
 * Aggregates per-node contribution weights (uptime, compute, storage) using
 * pure integer arithmetic to avoid IEEE 754 precision loss in the ratio
 * computation:
 *
 *   weight_i / total_weight
 *
 * A float division here would silently lose precision for large node counts
 * (~50,000 nodes) where the denominator exceeds 15 significant digits.
 *
 * @module weight_aggregator
 */

import { FixedPoint } from '../utils/math_precision';

// ── Types ────────────────────────────────────────────────────────────────────

export interface NodeWeight {
  /** Unique node identifier */
  nodeId: string;
  /** Uptime contribution (integer, 0 … 1_000_000) */
  uptimeWeight: bigint;
  /** Compute contribution (integer, 0 … 1_000_000) */
  computeWeight: bigint;
  /** Storage contribution (integer, 0 … 1_000_000) */
  storageWeight: bigint;
}

export interface AggregatedWeight {
  nodeId: string;
  /** Composite weight as a FixedPoint value (range [0, 1]) */
  compositeWeight: FixedPoint;
  /** Pool fraction (compositeWeight / sum of all compositeWeights) as FixedPoint */
  poolFraction: FixedPoint;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

const WEIGHT_MAX = 1_000_000n;

/**
 * Compute per-node composite weights and normalised pool fractions.
 *
 * Each node's composite weight is:
 *   composite = (uptimeWeight / 1_000_000) × (computeWeight / 1_000_000) × (storageWeight / 1_000_000)
 *
 * Pool fraction for node i:
 *   fraction_i = composite_i / Σ composite_j
 *
 * All operations remain in the integer domain via FixedPoint.
 *
 * @throws {RangeError} if any weight is outside [0, 1_000_000]
 * @throws {RangeError} if the total composite weight across all nodes is zero
 */
export function aggregateWeights(nodes: NodeWeight[]): AggregatedWeight[] {
  if (nodes.length === 0) return [];

  // Validate and compute composite weights
  const composites = nodes.map((node) => {
    assertWeightBounds(node.uptimeWeight, 'uptimeWeight', node.nodeId);
    assertWeightBounds(node.computeWeight, 'computeWeight', node.nodeId);
    assertWeightBounds(node.storageWeight, 'storageWeight', node.nodeId);

    const uptime = FixedPoint.fromRatio(node.uptimeWeight, WEIGHT_MAX);
    const compute = FixedPoint.fromRatio(node.computeWeight, WEIGHT_MAX);
    const storage = FixedPoint.fromRatio(node.storageWeight, WEIGHT_MAX);
    return { nodeId: node.nodeId, compositeWeight: uptime.mul(compute).mul(storage) };
  });

  // Sum all composite weights in integer domain
  const totalRaw = composites.reduce((acc, c) => acc + c.compositeWeight.toUnits(), 0n);
  if (totalRaw === 0n) {
    throw new RangeError(
      'aggregateWeights: total composite weight is zero — at least one node must have non-zero weights',
    );
  }

  const total = FixedPoint.fromRaw(totalRaw);

  // Normalise each node's weight using integer division (floor)
  return composites.map(({ nodeId, compositeWeight }) => ({
    nodeId,
    compositeWeight,
    poolFraction: compositeWeight.div(total),
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function assertWeightBounds(weight: bigint, name: string, nodeId: string): void {
  if (weight < 0n || weight > WEIGHT_MAX) {
    throw new RangeError(
      `aggregateWeights: ${name} for node "${nodeId}" is ${weight}, must be in [0, 1_000_000]`,
    );
  }
}
