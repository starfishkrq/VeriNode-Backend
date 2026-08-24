/**
 * Fixed-Point Arithmetic Safeguards — reward computation tests.
 *
 * Covers:
 *  1. FixedPoint primitive operations (add, sub, mul, div, fromRatio)
 *  2. calculateReward() — single-node fixed-point reward computation
 *  3. Property-based comparison: |fixed_point_result - float_result| < 1 unit
 *     across random weight triplets (uptime: [0,10^6], compute: [0,10^6], storage: [0,10^6])
 *  4. Sumcheck invariant assertion for distribution cycles
 *  5. aggregateWeights() normalised pool fractions
 *  6. Edge cases and invariant violations
 *
 * Test runner: tsx (Node assert — no external test framework required).
 */

import { strict as assert } from 'assert';
import {
  FixedPoint,
  FIXED_POINT_SCALE,
  MAX_REWARD_UNITS,
  MAX_CUMULATIVE_ERROR_UNITS,
  parseFixedPoint,
  assertDistributionSumcheck,
} from '../../src/utils/math_precision';
import { calculateRewardFloat } from '../../src/utils/math_float';
import { calculateReward, calculateBatchRewards } from '../../src/rewards/compute_engine';
import { aggregateWeights } from '../../src/staking/weight_aggregator';

// ── Deterministic PRNG (xorshift32) ──────────────────────────────────────────
// Avoids Math.random() non-determinism so the test suite is reproducible.

function xorshift32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

// ── Section 1: FixedPoint primitives ─────────────────────────────────────────

function testFixedPointFromRaw(): void {
  const fp = FixedPoint.fromRaw(10_000_000n);
  assert.equal(fp.toUnits(), 10_000_000n);
  assert.equal(fp.toString(), '1.0000000');
}

function testFixedPointFromInt(): void {
  const fp = FixedPoint.fromInt(5n);
  assert.equal(fp.toUnits(), 50_000_000n);
  assert.equal(fp.toString(), '5.0000000');
}

function testFixedPointFromRatio(): void {
  // 1/2 → 0.5000000 → 5_000_000 units
  const half = FixedPoint.fromRatio(1n, 2n);
  assert.equal(half.toUnits(), 5_000_000n);
  assert.equal(half.toString(), '0.5000000');

  // 1_000_000 / 1_000_000 → exactly 1.0000000
  const one = FixedPoint.fromRatio(1_000_000n, 1_000_000n);
  assert.equal(one.toUnits(), FIXED_POINT_SCALE);
}

function testFixedPointFromRatioZeroDenominator(): void {
  assert.throws(() => FixedPoint.fromRatio(1n, 0n), RangeError);
}

function testFixedPointAdd(): void {
  const a = FixedPoint.fromRatio(1n, 4n); // 0.25
  const b = FixedPoint.fromRatio(3n, 4n); // 0.75
  assert.equal(a.add(b).toUnits(), FIXED_POINT_SCALE); // 1.0
}

function testFixedPointSub(): void {
  const one = FixedPoint.fromInt(1n);
  const half = FixedPoint.fromRatio(1n, 2n);
  assert.equal(one.sub(half).toUnits(), half.toUnits());
}

function testFixedPointMul(): void {
  // 0.5 × 0.5 = 0.25
  const half = FixedPoint.fromRatio(1n, 2n);
  const quarter = half.mul(half);
  assert.equal(quarter.toUnits(), 2_500_000n);
}

function testFixedPointDiv(): void {
  // 1.0 / 2.0 = 0.5
  const one = FixedPoint.fromInt(1n);
  const two = FixedPoint.fromInt(2n);
  assert.equal(one.div(two).toUnits(), 5_000_000n);
}

function testFixedPointDivZero(): void {
  assert.throws(() => FixedPoint.fromInt(1n).div(FixedPoint.fromRaw(0n)), RangeError);
}

function testFixedPointAbs(): void {
  const neg = FixedPoint.fromRaw(-3_000_000n);
  assert.equal(neg.abs().toUnits(), 3_000_000n);
}

function testParseFixedPoint(): void {
  const fp = parseFixedPoint('12.3456789');
  assert.equal(fp.toUnits(), 123_456_789n);

  const fp2 = parseFixedPoint('0.0000001');
  assert.equal(fp2.toUnits(), 1n);

  assert.throws(() => parseFixedPoint('not-a-number'), Error);
  assert.throws(() => parseFixedPoint('-1.5'), Error); // negative not supported by regex
}

// ── Section 2: calculateReward single-node ────────────────────────────────────

function testCalculateRewardBasic(): void {
  // uptime=100%, compute=1_000_000, storage=1_000_000, pool=1_000_000 units, 1 node
  // reward = 1 × 1 × 1 × (1_000_000 / 1) = 1_000_000 units
  const result = calculateReward({
    uptimeNumerator: 1_000_000n,
    uptimeDenominator: 1_000_000n,
    computeWeight: 1_000_000n,
    storageWeight: 1_000_000n,
    totalPoolUnits: 1_000_000n,
    nodeCount: 1n,
  });
  assert.equal(result.units, 1_000_000n);
}

function testCalculateRewardZeroUptime(): void {
  const result = calculateReward({
    uptimeNumerator: 0n,
    uptimeDenominator: 1_000_000n,
    computeWeight: 1_000_000n,
    storageWeight: 1_000_000n,
    totalPoolUnits: 1_000_000n,
    nodeCount: 1n,
  });
  assert.equal(result.units, 0n);
}

function testCalculateRewardMultipleNodes(): void {
  // 10 equal nodes with full weights sharing a pool of 10_000_000 units
  // Each should get 1_000_000 units (minus floor rounding at most 1 unit)
  const result = calculateReward({
    uptimeNumerator: 1_000_000n,
    uptimeDenominator: 1_000_000n,
    computeWeight: 1_000_000n,
    storageWeight: 1_000_000n,
    totalPoolUnits: 10_000_000n,
    nodeCount: 10n,
  });
  assert.equal(result.units, 1_000_000n);
}

function testCalculateRewardInvalidInputs(): void {
  const base = {
    uptimeNumerator: 500_000n,
    uptimeDenominator: 1_000_000n,
    computeWeight: 500_000n,
    storageWeight: 500_000n,
    totalPoolUnits: 1_000_000n,
    nodeCount: 1n,
  };

  assert.throws(() => calculateReward({ ...base, uptimeDenominator: 0n }), RangeError);
  assert.throws(() => calculateReward({ ...base, nodeCount: 0n }), RangeError);
  assert.throws(
    () => calculateReward({ ...base, uptimeNumerator: 2_000_000n }),
    RangeError,
  );
  assert.throws(
    () => calculateReward({ ...base, computeWeight: 1_000_001n }),
    RangeError,
  );
  assert.throws(
    () => calculateReward({ ...base, storageWeight: -1n }),
    RangeError,
  );
}

function testCalculateRewardMaxNode(): void {
  // MAX_REWARD_UNITS = 10^12 — must not throw
  const result = calculateReward({
    uptimeNumerator: 1_000_000n,
    uptimeDenominator: 1_000_000n,
    computeWeight: 1_000_000n,
    storageWeight: 1_000_000n,
    totalPoolUnits: MAX_REWARD_UNITS,
    nodeCount: 1n,
  });
  assert.equal(result.units, MAX_REWARD_UNITS);
}

// ── Section 3: Property-based comparison (fixed vs float) ────────────────────
//
// For 1,000 random weight triplets, assert |fixed - float| < 1 unit.
// Uses a deterministic PRNG so results are reproducible.

function testPropertyFixedVsFloat(): void {
  const rand = xorshift32(0xdeadbeef);
  const MAX_W = 1_000_000;
  // Use a pool size small enough that float precision stays sub-unit while
  // still exercising the full weight range.
  // pool_per_node = 10_000_000 / 50_000 = 200 units → float error << 1 unit
  const TOTAL_POOL = 10_000_000n;  // 1 token
  const NODE_COUNT = 50_000n;
  const ITERATIONS = 1_000;

  for (let i = 0; i < ITERATIONS; i++) {
    const uptime = Math.floor(rand() * MAX_W);
    const compute = Math.floor(rand() * MAX_W);
    const storage = Math.floor(rand() * MAX_W);

    // Fixed-point path (integer domain)
    const fixedResult = calculateReward({
      uptimeNumerator: BigInt(uptime),
      uptimeDenominator: BigInt(MAX_W),
      computeWeight: BigInt(compute),
      storageWeight: BigInt(storage),
      totalPoolUnits: TOTAL_POOL,
      nodeCount: NODE_COUNT,
    });

    // Legacy float path (IEEE 754 doubles)
    const floatUnits = calculateRewardFloat(
      uptime,
      MAX_W,
      compute,
      storage,
      Number(TOTAL_POOL),
      Number(NODE_COUNT),
    );

    const floatRounded = BigInt(Math.floor(floatUnits));
    const diff =
      fixedResult.units > floatRounded
        ? fixedResult.units - floatRounded
        : floatRounded - fixedResult.units;

    // Both paths should agree to within 1 unit (10^-7 token)
    assert.ok(
      diff < MAX_CUMULATIVE_ERROR_UNITS + 1n,
      `Iteration ${i}: |fixed(${fixedResult.units}) - float(${floatRounded})| = ${diff} ≥ 1 unit. ` +
        `weights: uptime=${uptime}, compute=${compute}, storage=${storage}`,
    );
  }

  assert.ok(ITERATIONS === 1_000, 'Property test must run exactly 1,000 iterations');
}

// ── Section 4: Sumcheck invariant ────────────────────────────────────────────

function testSumcheckPassesExact(): void {
  // Exact match — no error
  assertDistributionSumcheck([500_000n, 500_000n], 1_000_000n);
}

function testSumcheckPassesWithinTolerance(): void {
  // Off by exactly 1 unit (floor rounding) — must pass
  assertDistributionSumcheck([499_999n, 500_000n], 1_000_000n);
}

function testSumcheckFailsExceedsTolerance(): void {
  // Off by 2 units — must throw
  assert.throws(
    () => assertDistributionSumcheck([499_998n, 500_000n], 1_000_000n),
    /INVARIANT VIOLATION/,
  );
}

function testSumcheckEmpty(): void {
  // Empty distribution is always valid against any pool size
  assertDistributionSumcheck([], 0n);
}

function testSumcheckLargePool(): void {
  // Simulate 50,000 nodes each receiving floor(10^12 / 50_000) units
  const NODE_COUNT = 50_000n;
  const TOTAL_POOL = 1_000_000_000_000n; // 10^12
  const perNode = TOTAL_POOL / NODE_COUNT; // 20_000_000 units each
  const remainder = TOTAL_POOL % NODE_COUNT; // 0 in this case

  const rewards = Array<bigint>(Number(NODE_COUNT)).fill(perNode);
  // Add remainder to the last node to match pool exactly
  if (remainder > 0n) {
    rewards[rewards.length - 1] += remainder;
  }

  // Must not throw
  assertDistributionSumcheck(rewards, TOTAL_POOL);
}

// ── Section 5: calculateBatchRewards ─────────────────────────────────────────

function testBatchRewardsConsistency(): void {
  const NODE_COUNT = 5;
  const TOTAL_POOL = 5_000_000n; // Each node should get exactly 1_000_000 units

  const inputs = Array.from({ length: NODE_COUNT }, (_, i) => ({
    nodeId: `node-${i}`,
    uptimeNumerator: 1_000_000n,
    uptimeDenominator: 1_000_000n,
    computeWeight: 1_000_000n,
    storageWeight: 1_000_000n,
    totalPoolUnits: TOTAL_POOL,
    nodeCount: BigInt(NODE_COUNT),
  }));

  const outputs = calculateBatchRewards(inputs);
  assert.equal(outputs.length, NODE_COUNT);
  for (const out of outputs) {
    assert.equal(out.units, 1_000_000n);
  }
}

// ── Section 6: aggregateWeights ───────────────────────────────────────────────

function testAggregateWeightsEqualNodes(): void {
  const nodes = [
    { nodeId: 'a', uptimeWeight: 1_000_000n, computeWeight: 1_000_000n, storageWeight: 1_000_000n },
    { nodeId: 'b', uptimeWeight: 1_000_000n, computeWeight: 1_000_000n, storageWeight: 1_000_000n },
  ];
  const result = aggregateWeights(nodes);
  assert.equal(result.length, 2);
  // Both composites are equal so each pool fraction should be 0.5
  assert.equal(result[0].poolFraction.toUnits(), result[1].poolFraction.toUnits());
}

function testAggregateWeightsEmpty(): void {
  const result = aggregateWeights([]);
  assert.deepEqual(result, []);
}

function testAggregateWeightsAllZero(): void {
  const nodes = [
    { nodeId: 'a', uptimeWeight: 0n, computeWeight: 0n, storageWeight: 0n },
  ];
  assert.throws(() => aggregateWeights(nodes), RangeError);
}

function testAggregateWeightsOutOfBounds(): void {
  assert.throws(
    () =>
      aggregateWeights([
        { nodeId: 'a', uptimeWeight: 1_000_001n, computeWeight: 500_000n, storageWeight: 500_000n },
      ]),
    RangeError,
  );
}

function testAggregateWeightsPoolFractionSumNearOne(): void {
  // 3 nodes with different weights — sum of all pool fractions must be close to 1.0
  const nodes = [
    { nodeId: 'a', uptimeWeight: 900_000n, computeWeight: 800_000n, storageWeight: 700_000n },
    { nodeId: 'b', uptimeWeight: 600_000n, computeWeight: 500_000n, storageWeight: 400_000n },
    { nodeId: 'c', uptimeWeight: 300_000n, computeWeight: 200_000n, storageWeight: 100_000n },
  ];
  const result = aggregateWeights(nodes);
  const sumRaw = result.reduce((acc, r) => acc + r.poolFraction.toUnits(), 0n);
  // Sum of fractions should be within 3 units of FIXED_POINT_SCALE (floor rounding)
  const diff =
    sumRaw > FIXED_POINT_SCALE ? sumRaw - FIXED_POINT_SCALE : FIXED_POINT_SCALE - sumRaw;
  assert.ok(diff <= 3n, `Pool fraction sum ${sumRaw} deviates from scale by ${diff} > 3 units`);
}

// ── Runner ────────────────────────────────────────────────────────────────────

type TestFn = () => void;
interface TestCase {
  name: string;
  fn: TestFn;
}

const tests: TestCase[] = [
  // FixedPoint primitives
  { name: 'FixedPoint.fromRaw', fn: testFixedPointFromRaw },
  { name: 'FixedPoint.fromInt', fn: testFixedPointFromInt },
  { name: 'FixedPoint.fromRatio', fn: testFixedPointFromRatio },
  { name: 'FixedPoint.fromRatio zero denominator', fn: testFixedPointFromRatioZeroDenominator },
  { name: 'FixedPoint.add', fn: testFixedPointAdd },
  { name: 'FixedPoint.sub', fn: testFixedPointSub },
  { name: 'FixedPoint.mul', fn: testFixedPointMul },
  { name: 'FixedPoint.div', fn: testFixedPointDiv },
  { name: 'FixedPoint.div by zero', fn: testFixedPointDivZero },
  { name: 'FixedPoint.abs', fn: testFixedPointAbs },
  { name: 'parseFixedPoint', fn: testParseFixedPoint },
  // calculateReward
  { name: 'calculateReward basic', fn: testCalculateRewardBasic },
  { name: 'calculateReward zero uptime', fn: testCalculateRewardZeroUptime },
  { name: 'calculateReward multiple nodes', fn: testCalculateRewardMultipleNodes },
  { name: 'calculateReward invalid inputs', fn: testCalculateRewardInvalidInputs },
  { name: 'calculateReward max node', fn: testCalculateRewardMaxNode },
  // Property-based float vs fixed
  { name: 'property: |fixed - float| < 1 unit (1,000 iterations)', fn: testPropertyFixedVsFloat },
  // Sumcheck
  { name: 'sumcheck passes exact', fn: testSumcheckPassesExact },
  { name: 'sumcheck passes within tolerance', fn: testSumcheckPassesWithinTolerance },
  { name: 'sumcheck fails exceeds tolerance', fn: testSumcheckFailsExceedsTolerance },
  { name: 'sumcheck empty', fn: testSumcheckEmpty },
  { name: 'sumcheck large pool (50k nodes)', fn: testSumcheckLargePool },
  // Batch rewards
  { name: 'calculateBatchRewards consistency', fn: testBatchRewardsConsistency },
  // aggregateWeights
  { name: 'aggregateWeights equal nodes', fn: testAggregateWeightsEqualNodes },
  { name: 'aggregateWeights empty', fn: testAggregateWeightsEmpty },
  { name: 'aggregateWeights all zero', fn: testAggregateWeightsAllZero },
  { name: 'aggregateWeights out of bounds', fn: testAggregateWeightsOutOfBounds },
  { name: 'aggregateWeights pool fraction sum near 1', fn: testAggregateWeightsPoolFractionSumNearOne },
];

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\nfixed-point arithmetic safeguards: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
