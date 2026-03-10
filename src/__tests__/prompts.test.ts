import { describe, it, expect } from "vitest";
import { rebalanceDecisionPrompt, vaultSelectionPrompt } from "../prompts";

describe("vaultSelectionPrompt", () => {
  it("interpolates config values into prompt", () => {
    const result = vaultSelectionPrompt({
      maxVaultAllocationPercent: 30,
      minVaultTvlUsd: 50000,
    });
    expect(result).toContain("30%");
    expect(result).toContain("50,000");
  });

  it("varies output with different config values", () => {
    const a = vaultSelectionPrompt({ maxVaultAllocationPercent: 30, minVaultTvlUsd: 50000 });
    const b = vaultSelectionPrompt({ maxVaultAllocationPercent: 80, minVaultTvlUsd: 500000 });
    expect(a).not.toBe(b);
  });
});

describe("rebalanceDecisionPrompt", () => {
  it("interpolates config values into prompt", () => {
    const result = rebalanceDecisionPrompt({ minSwapAmountUsd: 25 });
    expect(result).toContain("$25");
  });

  it("varies output with different config values", () => {
    const a = rebalanceDecisionPrompt({ minSwapAmountUsd: 10 });
    const b = rebalanceDecisionPrompt({ minSwapAmountUsd: 100 });
    expect(a).not.toBe(b);
  });
});
