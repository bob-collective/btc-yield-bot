import { describe, it, expect, vi } from "vitest";

vi.mock("../notify", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  ProfitTracker,
  formatVaultSummary,
  type VaultsfyiVault,
} from "../modules/portfolio";
import type { TransactionEntry } from "../modules/transactions";

// ---------------------------------------------------------------------------
// vaults.fyi yield discovery tests
// ---------------------------------------------------------------------------

const mockVaults: VaultsfyiVault[] = [
  {
    protocol: "morpho",
    asset: "USDC",
    address: "0xBEEF",
    apy30dTotal: 0.1986,
    apy30dBase: 0.1986,
    apy30dReward: 0,
    apy1dTotal: 0.1986,
    tvlUsd: 5_000_000,
    redeemStepsType: "instant",
  },
  {
    protocol: "lagoon",
    asset: "USDC",
    address: "0xLAGO",
    apy30dTotal: 0.0821,
    apy30dBase: 0.0821,
    apy30dReward: 0,
    apy1dTotal: 0,
    tvlUsd: 1_000_000,
    redeemStepsType: "request-redeem",
  },
  {
    protocol: "euler",
    asset: "USDC",
    address: "0xEULR",
    apy30dTotal: 0.0548,
    apy30dBase: 0.0548,
    apy30dReward: 0,
    apy1dTotal: 0.0677,
    tvlUsd: 800_000,
    redeemStepsType: "instant",
  },
];

describe("formatVaultSummary", () => {
  it("produces a markdown table with all vaults", () => {
    const summary = formatVaultSummary(mockVaults);
    expect(summary).toContain("Protocol");
    expect(summary).toContain("30d APY");
    expect(summary).toContain("Redeem");
    expect(summary).toContain("morpho");
    expect(summary).toContain("19.86%");
    expect(summary).toContain("instant");
  });

  it("respects the limit parameter", () => {
    const summary = formatVaultSummary(mockVaults, 2);
    expect(summary).toContain("morpho");
    expect(summary).toContain("lagoon");
    expect(summary).not.toContain("euler");
  });

  it("shows unknown for missing redeem type", () => {
    const vaults: VaultsfyiVault[] = [
      { ...mockVaults[0], redeemStepsType: undefined },
    ];
    const summary = formatVaultSummary(vaults);
    expect(summary).toContain("unknown");
  });

  it("returns header only for empty array", () => {
    const summary = formatVaultSummary([]);
    expect(summary).toContain("Protocol");
    const lines = summary.split("\n");
    expect(lines).toHaveLength(2); // header + separator
  });
});

// ---------------------------------------------------------------------------
// ProfitTracker tests
// ---------------------------------------------------------------------------

function makeTx(overrides: Partial<TransactionEntry> & Pick<TransactionEntry, "type">): TransactionEntry {
  return {
    timestamp: new Date().toISOString(),
    tokenIn: "USDC",
    amountIn: "0",
    usdValueAtTime: 0,
    txHash: "0x" + Math.random().toString(16).slice(2),
    ...overrides,
  };
}

describe("ProfitTracker", () => {
  const tracker = new ProfitTracker();

  describe("getTotalFunding", () => {
    it("sums funding_received entries", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
        makeTx({ type: "funding_received", usdValueAtTime: 500 }),
        makeTx({ type: "deposit", usdValueAtTime: 200 }),
      ];
      expect(tracker.getTotalFunding(entries)).toBe(1500);
    });

    it("returns 0 when no funding_received entries exist", () => {
      const entries = [makeTx({ type: "deposit", usdValueAtTime: 100 })];
      expect(tracker.getTotalFunding(entries)).toBe(0);
    });
  });

  describe("getTotalCashedOut", () => {
    it("sums cash_out_btc entries", () => {
      const entries = [
        makeTx({ type: "cash_out_btc", usdValueAtTime: 300 }),
        makeTx({ type: "cash_out_btc", usdValueAtTime: 150 }),
        makeTx({ type: "withdraw", usdValueAtTime: 999 }),
      ];
      expect(tracker.getTotalCashedOut(entries)).toBe(450);
    });

    it("returns 0 when no cash_out_btc entries exist", () => {
      const entries = [makeTx({ type: "funding_received", usdValueAtTime: 100 })];
      expect(tracker.getTotalCashedOut(entries)).toBe(0);
    });
  });

  describe("getRemainingPrincipal", () => {
    it("returns total funding minus total cashed out", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
        makeTx({ type: "funding_received", usdValueAtTime: 500 }),
        makeTx({ type: "cash_out_btc", usdValueAtTime: 200 }),
      ];
      expect(tracker.getRemainingPrincipal(entries)).toBe(1300);
    });

    it("returns full funding when nothing cashed out", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
      ];
      expect(tracker.getRemainingPrincipal(entries)).toBe(1000);
    });

    it("returns 0 when all funding cashed out", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
        makeTx({ type: "cash_out_btc", usdValueAtTime: 1000 }),
      ];
      expect(tracker.getRemainingPrincipal(entries)).toBe(0);
    });
  });

  describe("getVaultHistory", () => {
    it("groups deposits and withdrawals by vault", () => {
      const entries = [
        makeTx({ type: "deposit", usdValueAtTime: 500, protocol: "aave", vault: "aave-usdc" }),
        makeTx({ type: "deposit", usdValueAtTime: 300, protocol: "compound", vault: "comp-eth" }),
        makeTx({ type: "withdraw", usdValueAtTime: 600, protocol: "aave", vault: "aave-usdc" }),
      ];

      const history = tracker.getVaultHistory(entries);
      expect(history).toHaveLength(2);

      const aave = history.find((h) => h.vault === "aave-usdc")!;
      expect(aave.totalDeposited).toBe(500);
      expect(aave.totalWithdrawn).toBe(600);
      expect(aave.realizedPnl).toBe(100);
      expect(aave.isActive).toBe(false);

      const comp = history.find((h) => h.vault === "comp-eth")!;
      expect(comp.totalDeposited).toBe(300);
      expect(comp.totalWithdrawn).toBe(0);
      expect(comp.realizedPnl).toBe(-300);
      expect(comp.isActive).toBe(true);
    });

    it("excludes entries without a vault address", () => {
      const entries = [
        makeTx({ type: "deposit", usdValueAtTime: 100, protocol: "sushi" }),
      ];
      const history = tracker.getVaultHistory(entries);
      expect(history).toHaveLength(0);
    });

    it("marks vault active after partial withdrawal", () => {
      const entries = [
        makeTx({ type: "deposit", usdValueAtTime: 500, protocol: "morpho", vault: "morpho-usdc" }),
        makeTx({ type: "withdraw", usdValueAtTime: 100, protocol: "morpho", vault: "morpho-usdc" }),
      ];
      const history = tracker.getVaultHistory(entries);
      const morpho = history.find((h) => h.vault === "morpho-usdc")!;
      expect(morpho.totalDeposited).toBe(500);
      expect(morpho.totalWithdrawn).toBe(100);
      expect(morpho.isActive).toBe(true);
    });

    it("ignores entries without a protocol", () => {
      const entries = [
        makeTx({ type: "deposit", usdValueAtTime: 100 }),
      ];
      const history = tracker.getVaultHistory(entries);
      expect(history).toHaveLength(0);
    });

    it("ignores non-deposit/withdraw entries", () => {
      const entries = [
        makeTx({ type: "swap", usdValueAtTime: 100, protocol: "sushi" }),
        makeTx({ type: "claim_reward", usdValueAtTime: 50, protocol: "aave" }),
      ];
      const history = tracker.getVaultHistory(entries);
      expect(history).toHaveLength(0);
    });
  });

  describe("calculateProfit", () => {
    it("returns portfolioValue minus remaining principal", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
      ];
      expect(tracker.calculateProfit(entries, 1200)).toBe(200);
    });

    it("accounts for prior cash-outs in profit calculation", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
        makeTx({ type: "cash_out_btc", usdValueAtTime: 300 }),
      ];
      // remaining principal = 1000 - 300 = 700
      // profit = 800 - 700 = 100
      expect(tracker.calculateProfit(entries, 800)).toBe(100);
    });

    it("returns negative when portfolio is below remaining principal", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
        makeTx({ type: "cash_out_btc", usdValueAtTime: 200 }),
      ];
      // remaining principal = 800, portfolio = 500
      expect(tracker.calculateProfit(entries, 500)).toBe(-300);
    });
  });

  describe("shouldCashOut", () => {
    it("returns true when profit exceeds threshold", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
      ];
      expect(tracker.shouldCashOut(entries, 1600, 500)).toBe(true);
    });

    it("returns true with prior cash-outs reducing principal", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
        makeTx({ type: "cash_out_btc", usdValueAtTime: 400 }),
      ];
      // remaining principal = 600, portfolio = 1200, profit = 600
      expect(tracker.shouldCashOut(entries, 1200, 500)).toBe(true);
    });

    it("returns false when profit is below threshold", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
      ];
      expect(tracker.shouldCashOut(entries, 1200, 500)).toBe(false);
    });

    it("returns false when profit exactly equals threshold", () => {
      const entries = [
        makeTx({ type: "funding_received", usdValueAtTime: 1000 }),
      ];
      expect(tracker.shouldCashOut(entries, 1500, 500)).toBe(false);
    });
  });
});

