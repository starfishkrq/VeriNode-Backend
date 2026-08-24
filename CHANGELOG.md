# Changelog

All notable changes to VeriNode-Backend are documented here.

---

## [Unreleased]

### Added — Fixed-Point Arithmetic Safeguards (#217)

Closes [#217](https://github.com/VeriNode-Labs/VeriNode-Backend/issues/217):
*Fixed-Point Arithmetic Safeguards Eradicating Staking Conversion Float Variations*

#### Problem

Translating physical computing contribution weights into Soroban 7-decimal integer
payouts introduced fractional rounding variances via IEEE 754 doubles. The
multiplication chain:

```
uptime_weight × compute_weight × storage_weight × pool_fraction
```

accumulated sub-cent errors (IEEE 754 loses precision at ~15 significant digits).
Across 50,000 nodes per cycle this produced a discrepancy of up to 0.3 % of the
total reward pool — either under-issuing or over-issuing tokens.

#### Solution

All reward computation now operates in the **pure integer domain** using the new
`FixedPoint` class backed by `bigint` (wrapping the same i128 semantics as the
Soroban smart-contract layer).

#### New Files

| File | Purpose |
|------|---------|
| `src/utils/math_precision.ts` | `FixedPoint` struct with `add`, `sub`, `mul`, `div`, `fromRatio`; `assertDistributionSumcheck()` |
| `src/rewards/compute_engine.ts` | `calculateReward()` and `calculateBatchRewards()` — fixed-point reward engine |
| `src/staking/weight_aggregator.ts` | `aggregateWeights()` — normalised pool fractions in integer domain |
| `src/utils/math_float.ts` | **Deprecated** float path (kept for migration window only) |
| `tests/rewards/distributor.test.ts` | 1,000-iteration property-based test asserting \|fixed − float\| < 1 unit; sumcheck tests; batch rewards |
| `CHANGELOG.md` | This file |

#### Technical Invariants Maintained

- Soroban i128 fixed-point: 7 decimal places (`1 unit = 10^-7 token`)
- Maximum reward per node: `10^12` units (100,000 tokens)
- Cumulative error tolerance: `< 1 unit (10^-7 token)` across all nodes
- All intermediate values remain in the integer domain

#### Migration Guide for Downstream Callers

**Any code calling `math_float.ts` (`calculateRewardFloat`) MUST migrate to the
new fixed-point path before the float module is removed.**

##### Before (deprecated — do not use)

```typescript
import { calculateRewardFloat } from './utils/math_float';

const units = calculateRewardFloat(
  uptimeNumerator,   // number
  uptimeDenominator, // number
  computeWeight,     // number
  storageWeight,     // number
  totalPoolUnits,    // number
  nodeCount,         // number
);
```

##### After (required)

```typescript
import { calculateReward } from './rewards/compute_engine';

const { units, formatted } = calculateReward({
  uptimeNumerator:   BigInt(uptimeNumerator),
  uptimeDenominator: BigInt(uptimeDenominator),
  computeWeight:     BigInt(computeWeight),
  storageWeight:     BigInt(storageWeight),
  totalPoolUnits:    BigInt(totalPoolUnits),
  nodeCount:         BigInt(nodeCount),
});
// units: bigint — raw 7-decimal units, safe to store in DB / pass to Soroban
// formatted: string — human-readable "N.DDDDDDD"
```

##### Using FixedPoint directly

```typescript
import { FixedPoint, assertDistributionSumcheck } from './utils/math_precision';

const uptime  = FixedPoint.fromRatio(uptimeNumerator,  uptimeDenominator);
const compute = FixedPoint.fromRatio(computeWeight,    1_000_000n);
const storage = FixedPoint.fromRatio(storageWeight,    1_000_000n);
const share   = FixedPoint.fromRatio(totalPoolUnits,   nodeCount);
const reward  = uptime.mul(compute).mul(storage).mul(share);

// After a full distribution cycle, verify the sumcheck:
assertDistributionSumcheck(allRewardUnits, totalPoolUnits);
```

##### Using weight aggregation

```typescript
import { aggregateWeights } from './staking/weight_aggregator';

const fractions = aggregateWeights(nodes);
// fractions[i].poolFraction — FixedPoint in [0, 1], integer domain
```

#### Deprecation Timeline

- `src/utils/math_float.ts` — **deprecated as of this release**.
  Will be removed in the next minor version once all callers have migrated.
  The file emits a JSDoc `@deprecated` warning visible in IDEs.
