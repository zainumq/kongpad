import { describe, expect, it } from "vitest";
import {
  BLOCKED_CONFIG,
  explorerAddress,
  explorerTx,
  isBlockedConfig,
  shortAddress,
} from "./giwa";

describe("isBlockedConfig", () => {
  it("blocks Config #6 by id", () => {
    expect(BLOCKED_CONFIG.id).toBe(6n);
    expect(isBlockedConfig(6n)).toBe(true);
    expect(isBlockedConfig(10n)).toBe(false);
    expect(isBlockedConfig(12n)).toBe(false);
  });

  it("blocks by config hash, case-insensitively", () => {
    expect(isBlockedConfig(10n, BLOCKED_CONFIG.hash)).toBe(true);
    expect(isBlockedConfig(10n, BLOCKED_CONFIG.hash.toUpperCase())).toBe(true);
    expect(isBlockedConfig(10n, "0x1234")).toBe(false);
  });
});

describe("explorer links", () => {
  it("builds GIWA Sepolia explorer URLs", () => {
    expect(explorerTx("0xabc")).toBe("https://sepolia-explorer.giwa.io/tx/0xabc");
    expect(explorerAddress("0xabc")).toBe("https://sepolia-explorer.giwa.io/address/0xabc");
  });
});

describe("shortAddress", () => {
  it("shortens long addresses and leaves short ones alone", () => {
    expect(shortAddress("0xf04c62C4634DacA5e46528E16F654510ea1a1849")).toBe("0xf04c…1849");
    expect(shortAddress("0xabc")).toBe("0xabc");
  });
});
