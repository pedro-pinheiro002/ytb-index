/**
 * YouTube Data API v3 quota accounting.
 *
 * The Data API grants a default budget of 10,000 units/day (spec §8). We keep a
 * safety margin and default to 9,500 units so a run aborts *before* the hard
 * limit is hit. `QuotaCounter` is a tiny synchronous in-memory ledger; the
 * ingest pipeline (#T06) consults it before/after each API call.
 *
 * Pure: no I/O, no globals, no knowledge of the YouTube client itself.
 */

/**
 * Thrown when a `consume` call would push the running total past the budget.
 * The attempted units are *not* added: the counter is left unchanged.
 */
export class QuotaExceededError extends Error {
  /** Distinguishes this error from arbitrary `Error`s in `catch` blocks. */
  override readonly name = 'QuotaExceededError';

  /** Total that would have resulted from the rejected call. */
  readonly attemptedTotal: number;
  /** Configured budget. */
  readonly budget: number;
  /** Units requested by the rejected call. */
  readonly units: number;

  constructor(attemptedTotal: number, budget: number, units: number) {
    super(
      `Quota exceeded: consuming ${units} units would reach ${attemptedTotal} of ${budget} budget.`,
    );
    this.attemptedTotal = attemptedTotal;
    this.budget = budget;
    this.units = units;
  }
}

/**
 * Running tally of consumed YouTube Data API quota units.
 *
 * Default budget is 9,500 (10,000 minus a 500-unit safety margin).
 */
export class QuotaCounter {
  readonly #budget: number;
  #total = 0;

  constructor(budget = 9500) {
    this.#budget = budget;
  }

  /** Configured budget (units). */
  get budget(): number {
    return this.#budget;
  }

  /** Units consumed so far. */
  get total(): number {
    return this.#total;
  }

  /**
   * Account for `units` of quota. Increments first, then throws if the new
   * total exceeds the budget, leaving the counter untouched.
   *
   * @throws {QuotaExceededError} when `total + units > budget`.
   */
  consume(units: number): void {
    const attemptedTotal = this.#total + units;
    if (attemptedTotal > this.#budget) {
      throw new QuotaExceededError(attemptedTotal, this.#budget, units);
    }
    this.#total = attemptedTotal;
  }
}
