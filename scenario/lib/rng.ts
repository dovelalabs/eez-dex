/**
 * Seeded randomness — RD-2 HX-4, and `CLAUDE.md`'s determinism-by-default.
 *
 * The soak is 200 slots of randomised order flow against a random-walk price.
 * Randomised is not the same as irreproducible: the seed is an input, it is
 * printed at the start of every run, and the same seed replays the same 200
 * slots. A soak that fails at slot 173 and cannot be re-run is not a test.
 *
 * SplitMix64, chosen because it is eight lines, has no state to get wrong, and
 * gives the same stream in any language a later reader reimplements it in.
 */

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;

/** A reproducible source of randomness. */
export class Rng {
  private state: bigint;

  constructor(seed: bigint | number) {
    this.state = BigInt(seed) & MASK64;
  }

  /** The next 64 bits. */
  next(): bigint {
    this.state = (this.state + GOLDEN) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
  }

  /** A value in `[low, high]`, inclusive. */
  inRange(low: bigint, high: bigint): bigint {
    if (high < low) throw new Error(`inRange: ${high} < ${low}`);
    const span = high - low + 1n;
    return low + (this.next() % span);
  }

  /** A whole number in `[low, high]`, inclusive. */
  intInRange(low: number, high: number): number {
    return Number(this.inRange(BigInt(low), BigInt(high)));
  }

  /** True with probability `numerator / denominator`. */
  chance(numerator: number, denominator: number): boolean {
    return this.intInRange(1, denominator) <= numerator;
  }

  /** One of `items`, uniformly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick: nothing to pick from");
    const item = items[this.intInRange(0, items.length - 1)];
    if (item === undefined) throw new Error("pick: index out of range");
    return item;
  }

  /** A Fisher-Yates shuffle, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.intInRange(0, i);
      const a = items[i];
      const b = items[j];
      if (a === undefined || b === undefined) continue;
      items[i] = b;
      items[j] = a;
    }
    return items;
  }
}
