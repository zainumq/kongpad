import { describe, expect, it } from "vitest";
import { curvePriceImpactBps, fmt } from "./ammora";

describe("fmt", () => {
  it("formats whole values without a fraction", () => {
    expect(fmt(0n, 18)).toBe("0");
    expect(fmt(1000000000000000000n, 18)).toBe("1");
  });

  it("trims trailing zeros in the fraction", () => {
    expect(fmt(1500000000000000000n, 18)).toBe("1.5");
    expect(fmt(1000000000000000001n, 18)).toBe("1");
  });

  it("truncates to maxDp decimal places", () => {
    expect(fmt(1234567890000000000n, 18)).toBe("1.234567");
    expect(fmt(1234567890000000000n, 18, 2)).toBe("1.23");
  });

  it("renders sub-precision dust as zero", () => {
    expect(fmt(1n, 18)).toBe("0");
  });
});

describe("curvePriceImpactBps", () => {
  const SPOT_ONE = 1n << 64n; // sqrtPrice for a spot price of 1

  it("returns null for non-positive inputs", () => {
    expect(curvePriceImpactBps(1000n, 990n, 0n, true)).toBeNull();
    expect(curvePriceImpactBps(0n, 990n, SPOT_ONE, true)).toBeNull();
    expect(curvePriceImpactBps(1000n, 0n, SPOT_ONE, true)).toBeNull();
  });

  it("returns zero when execution equals spot", () => {
    expect(curvePriceImpactBps(1000n, 1000n, SPOT_ONE, true)).toBe(0n);
  });

  it("measures a 1% move as 100 bps (base for quote)", () => {
    expect(curvePriceImpactBps(1000n, 990n, SPOT_ONE, true)).toBe(100n);
  });

  it("measures the reverse direction (quote for base)", () => {
    expect(curvePriceImpactBps(1000n, 990n, SPOT_ONE, false)).toBe(101n);
  });
});
