/**
 * Fixed-point arithmetic safeguards for Soroban 7-decimal integer payouts.
 *
 * Soroban i128 fixed-point: 7 decimal places (1 unit = 10^-7 token).
 * Maximum reward per node: 10^12 units (100,000 tokens).
 * Cumulative error tolerance: < 1 unit (10^-7 token) across all nodes.
 *
 * All intermediate values remain in the integer domain — no IEEE 754 floats
 * are used during reward computation, eliminating sub-cent rounding variances
 * that accumulate across 50,000-node reward cycles.
 *
 * @module math_precision
 */

/** Soroban fixed-point scale: 7 decimal places → 1 token = 10^7 units */
export const FIXED_POINT_DECIMALS = 7 as const;

/** Scale factor: 10^7 */
export const FIXED_POINT_SCALE = 10_000_000n;

/** Maximum representable reward per node: 10^12 units = 100,000 tokens */
export const MAX_REWARD_UNITS = 1_000_000_000_000n;

/** Cumulative error tolerance across an entire reward cycle: < 1 unit */
export const MAX_CUMULATIVE_ERROR_UNITS = 1n;

/**
 * FixedPoint<DECIMALS> wraps a bigint mantissa and exposes safe arithmetic.
 *
 * All operations remain in the integer domain. Division truncates toward zero
 * (floor for positive values) to guarantee deterministic cross-platform results
 * — matching RoundingStrategy::Floor from the Rust `rust_decimal` crate.
 */
export class FixedPoint {
  /** Raw integer mantissa (value × 10^DECIMALS) */
  readonly raw: bigint;

  private constructor(raw: bigint) {
    this.raw = raw;
  }

  // ── Construction ──────────────────────────────────────────────────────────

  /**
   * Wrap a raw integer mantissa as a FixedPoint value.
   * Use this when the value is already scaled (e.g. stored DB units).
   */
  static fromRaw(raw: bigint): FixedPoint {
    return new FixedPoint(raw);
  }

  /**
   * Build a FixedPoint from an integer token count (no fractional part).
   * `fromInt(1)` == 1.0000000 tokens == 10_000_000 units.
   */
  static fromInt(value: bigint): FixedPoint {
    return new FixedPoint(value * FIXED_POINT_SCALE);
  }

  /**
   * Build a FixedPoint from a numerator/denominator pair.
   * Intermediate multiplication keeps full precision before the final division.
   *
   * `fromRatio(uptime_numerator, uptime_denominator)` replaces
   * `uptime_pct = uptime_numerator / uptime_denominator` in float space.
   *
   * @throws {RangeError} if denominator is zero
   */
  static fromRatio(numerator: bigint, denominator: bigint): FixedPoint {
    if (denominator === 0n) {
      throw new RangeError('FixedPoint.fromRatio: denominator must not be zero');
    }
    // Scale numerator before dividing to preserve precision (floor division)
    return new FixedPoint((numerator * FIXED_POINT_SCALE) / denominator);
  }

  // ── Arithmetic ────────────────────────────────────────────────────────────

  /** Integer addition — no precision loss. */
  add(other: FixedPoint): FixedPoint {
    return new FixedPoint(this.raw + other.raw);
  }

  /** Integer subtraction — no precision loss. */
  sub(other: FixedPoint): FixedPoint {
    return new FixedPoint(this.raw - other.raw);
  }

  /**
   * Fixed-point multiplication.
   * `(a × scale) × (b × scale) / scale = (a × b) × scale`
   * Uses integer division (floor) to stay deterministic.
   */
  mul(other: FixedPoint): FixedPoint {
    return new FixedPoint((this.raw * other.raw) / FIXED_POINT_SCALE);
  }

  /**
   * Fixed-point division.
   * `(a × scale) / (b × scale / scale) = (a × scale^2) / (b × scale)`
   * Simplified: `(this.raw × scale) / other.raw`
   *
   * @throws {RangeError} if other is zero
   */
  div(other: FixedPoint): FixedPoint {
    if (other.raw === 0n) {
      throw new RangeError('FixedPoint.div: divisor must not be zero');
    }
    return new FixedPoint((this.raw * FIXED_POINT_SCALE) / other.raw);
  }

  // ── Comparison ────────────────────────────────────────────────────────────

  eq(other: FixedPoint): boolean {
    return this.raw === other.raw;
  }

  lt(other: FixedPoint): boolean {
    return this.raw < other.raw;
  }

  lte(other: FixedPoint): boolean {
    return this.raw <= other.raw;
  }

  gt(other: FixedPoint): boolean {
    return this.raw > other.raw;
  }

  gte(other: FixedPoint): boolean {
    return this.raw >= other.raw;
  }

  // ── Absolute value ────────────────────────────────────────────────────────

  abs(): FixedPoint {
    return new FixedPoint(this.raw < 0n ? -this.raw : this.raw);
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  /**
   * Format as a 7-decimal string (e.g. "1.0000000").
   * This is the canonical on-chain/wire representation.
   */
  toString(): string {
    const sign = this.raw < 0n ? '-' : '';
    const abs = this.raw < 0n ? -this.raw : this.raw;
    const whole = abs / FIXED_POINT_SCALE;
    const fraction = abs % FIXED_POINT_SCALE;
    return `${sign}${whole}.${fraction.toString().padStart(7, '0')}`;
  }

  /**
   * Return raw integer units (mantissa).
   * Useful for asserting invariants and storing in DB as integer columns.
   */
  toUnits(): bigint {
    return this.raw;
  }
}

// ── Module-level convenience wrappers ────────────────────────────────────────

/**
 * Parse a 7-decimal string representation back into a FixedPoint value.
 * Accepts strings of the form "NNN.DDDDDDD" (fractional part optional).
 * Negative values are not supported — reward units are always non-negative.
 *
 * @throws {Error} for malformed input or negative values
 */
export function parseFixedPoint(value: string): FixedPoint {
  const match = value.match(/^(\d+)(?:\.(\d{0,7}))?$/);
  if (!match) {
    throw new Error(`parseFixedPoint: invalid 7-decimal value: "${value}"`);
  }
  const [, whole, frac = ''] = match;
  const raw =
    BigInt(whole) * FIXED_POINT_SCALE + BigInt(frac.padEnd(7, '0'));
  return FixedPoint.fromRaw(raw);
}

/**
 * Assert the sumcheck invariant for a completed reward distribution cycle.
 *
 * Computes Σ distributed_i and checks |Σ - pool| ≤ MAX_CUMULATIVE_ERROR_UNITS.
 * If the invariant is violated the function throws — the caller must treat this
 * as a fatal cycle integrity failure (do NOT settle the cycle).
 *
 * @param distributed Array of per-node reward amounts (raw units, bigint)
 * @param totalPoolUnits Total reward pool in raw units (bigint)
 * @throws {Error} invariant violation with the measured discrepancy
 */
export function assertDistributionSumcheck(
  distributed: bigint[],
  totalPoolUnits: bigint,
): void {
  const sum = distributed.reduce((acc, v) => acc + v, 0n);
  const diff = sum > totalPoolUnits ? sum - totalPoolUnits : totalPoolUnits - sum;
  if (diff > MAX_CUMULATIVE_ERROR_UNITS) {
    throw new Error(
      `Reward distribution sumcheck INVARIANT VIOLATION: ` +
        `|sum(${sum}) - pool(${totalPoolUnits})| = ${diff} > ${MAX_CUMULATIVE_ERROR_UNITS} unit(s). ` +
        `Cycle must not be settled.`,
    );
  }
}
