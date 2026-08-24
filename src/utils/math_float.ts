/**
 * @deprecated Legacy IEEE 754 float reward computation path.
 *
 * ⚠️  MIGRATION NOTICE — see CHANGELOG.md §"Fixed-Point Arithmetic Safeguards"
 *
 * This module uses JavaScript `number` (IEEE 754 double-precision) for reward
 * calculations.  At ~15 significant digits of precision the multiplication chain
 *
 *   uptime_weight × compute_weight × storage_weight × pool_fraction
 *
 * accumulates sub-cent rounding errors.  Across 50,000 nodes per reward cycle
 * the aggregate discrepancy can reach ±0.3 % of the total reward pool, causing
 * systematic under- or over-issuance of tokens.
 *
 * ─── DO NOT USE FOR NEW CODE ───────────────────────────────────────────────
 * Switch all callers to the fixed-point path provided by:
 *   import { calculateReward } from '../rewards/compute_engine';
 * or use FixedPoint arithmetic directly via:
 *   import { FixedPoint } from './math_precision';
 * ───────────────────────────────────────────────────────────────────────────
 *
 * This file is retained only so that existing call-sites compile during the
 * migration window.  It will be removed once all callers have migrated.
 *
 * @module math_float
 */

/**
 * @deprecated Use {@link calculateReward} from `../rewards/compute_engine` instead.
 *
 * Compute a node reward weight using floating-point arithmetic.
 * Returns a raw 7-decimal unit count as a `number`, which loses precision
 * beyond ~15 significant digits and produces non-deterministic rounding
 * across hardware/platform combinations.
 *
 * @param uptimeNumerator   Uptime measured value  (integer, 0 … uptimeDenominator)
 * @param uptimeDenominator Uptime measurement base (integer, > 0)
 * @param computeWeight     Compute contribution weight (integer, 0 … 1_000_000)
 * @param storageWeight     Storage contribution weight (integer, 0 … 1_000_000)
 * @param totalPoolUnits    Total reward pool in raw 7-decimal units
 * @param nodeCount         Number of nodes sharing the pool (> 0)
 * @returns Raw 7-decimal reward units as a floating-point number (imprecise)
 */
export function calculateRewardFloat(
  uptimeNumerator: number,
  uptimeDenominator: number,
  computeWeight: number,
  storageWeight: number,
  totalPoolUnits: number,
  nodeCount: number,
): number {
  if (uptimeDenominator <= 0) throw new RangeError('uptimeDenominator must be > 0');
  if (nodeCount <= 0) throw new RangeError('nodeCount must be > 0');

  const uptimePct = uptimeNumerator / uptimeDenominator;
  const computeFraction = computeWeight / 1_000_000;
  const storageFraction = storageWeight / 1_000_000;

  // poolPerNode: raw units per node (totalPoolUnits is already in 7-decimal units)
  const poolPerNode = totalPoolUnits / nodeCount;

  // IEEE 754 double multiplication — sub-cent errors accumulate here
  return uptimePct * computeFraction * storageFraction * poolPerNode;
}
