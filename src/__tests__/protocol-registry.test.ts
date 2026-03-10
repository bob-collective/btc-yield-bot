import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import {
  ProtocolRegistry,
  type VaultEntry,
} from "../modules/protocol-registry";

vi.mock("../notify", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("ProtocolRegistry", () => {
  const testPath = "/tmp/test-protocol-registry.json";

  beforeEach(() => {
    if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
  });

  afterEach(() => {
    if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
  });

  it("creates empty registry when file does not exist", () => {
    const registry = new ProtocolRegistry(testPath);
    expect(registry.getAll()).toEqual({});
  });

  it("loads existing registry from disk", () => {
    const data = {
      vaults: {
        "0xabc:base": {
          protocol: "morpho",
          symbol: "USDC",
          redeemType: "instant" as const,
          checkedAt: "2026-03-07T12:00:00Z",
        },
      },
    };
    fs.writeFileSync(testPath, JSON.stringify(data));
    const registry = new ProtocolRegistry(testPath);
    expect(registry.lookup("0xabc", "base")).toEqual(data.vaults["0xabc:base"]);
  });

  it("returns undefined for unknown vault", () => {
    const registry = new ProtocolRegistry(testPath);
    expect(registry.lookup("0xunknown", "base")).toBeUndefined();
  });

  it("adds a vault entry and persists to disk", () => {
    const registry = new ProtocolRegistry(testPath);
    const entry: VaultEntry = {
      protocol: "aave-v3",
      symbol: "USDC",
      redeemType: "instant",
      checkedAt: "2026-03-07T12:00:00Z",
    };
    registry.add("0xdef", "base", entry);

    expect(registry.lookup("0xdef", "base")).toEqual(entry);

    // Verify persistence
    const raw = JSON.parse(fs.readFileSync(testPath, "utf-8"));
    expect(raw.vaults["0xdef:base"]).toEqual(entry);
  });

  it("isInstant returns true for instant vaults", () => {
    const registry = new ProtocolRegistry(testPath);
    registry.add("0x1", "base", {
      protocol: "morpho",
      symbol: "USDC",
      redeemType: "instant",
      checkedAt: "2026-03-07T12:00:00Z",
    });
    expect(registry.isInstant("0x1", "base")).toBe(true);
  });

  it("isInstant returns false for complex vaults", () => {
    const registry = new ProtocolRegistry(testPath);
    registry.add("0x2", "base", {
      protocol: "ethena",
      symbol: "USDe",
      redeemType: "complex",
      checkedAt: "2026-03-07T12:00:00Z",
    });
    expect(registry.isInstant("0x2", "base")).toBe(false);
  });

  it("isInstant returns undefined for unknown vaults", () => {
    const registry = new ProtocolRegistry(testPath);
    expect(registry.isInstant("0xunknown", "base")).toBeUndefined();
  });

  it("getAll returns all vault entries", () => {
    const registry = new ProtocolRegistry(testPath);
    registry.add("0x1", "base", {
      protocol: "morpho",
      symbol: "USDC",
      redeemType: "instant",
      checkedAt: "2026-03-07T12:00:00Z",
    });
    registry.add("0x2", "base", {
      protocol: "ethena",
      symbol: "USDe",
      redeemType: "complex",
      checkedAt: "2026-03-07T12:00:00Z",
    });
    const all = registry.getAll();
    expect(Object.keys(all)).toHaveLength(2);
  });

  it("formatForPrompt lists known vaults grouped by type", () => {
    const registry = new ProtocolRegistry(testPath);
    registry.add("0x1", "base", {
      protocol: "morpho",
      symbol: "USDC",
      redeemType: "instant",
      checkedAt: "2026-03-07T12:00:00Z",
    });
    registry.add("0x2", "base", {
      protocol: "ethena",
      symbol: "USDe",
      redeemType: "complex",
      checkedAt: "2026-03-07T12:00:00Z",
    });
    const text = registry.formatForPrompt();
    expect(text).toContain("morpho");
    expect(text).toContain("instant");
    expect(text).toContain("ethena");
    expect(text).toContain("complex");
  });
});
