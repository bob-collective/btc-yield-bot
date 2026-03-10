import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TxLogger,
  TransactionEntry,
  mapContextToTxType,
  parseAmountFromOutput,
  parseProtocolFromOutput,
  parseUsdValueFromOutput,
  processCapturedTxs,
  isErc20ApprovOrTransfer,
} from "../modules/transactions";
import type { CapturedTx } from "../modules/instrumented-wallet";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// TxLogger tests (from tx-logger.test.ts)
// ---------------------------------------------------------------------------

describe("TxLogger", () => {
  let tmpDir: string;
  let logger: TxLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "txlog-"));
    logger = new TxLogger(path.join(tmpDir, "transactions.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleEntry: Omit<TransactionEntry, "timestamp"> = {
    type: "deposit",
    tokenIn: "USDC",
    amountIn: "1000",
    usdValueAtTime: 1000,
    txHash: "0xabc123",
    protocol: "morpho",
    vault: "0xvault",
  };

  it("appends a transaction and retrieves it", () => {
    logger.log(sampleEntry);
    const entries = logger.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("deposit");
    expect(entries[0].tokenIn).toBe("USDC");
    expect(entries[0].timestamp).toBeDefined();
  });

  it("persists to disk and loads on new instance", () => {
    logger.log(sampleEntry);
    const logger2 = new TxLogger(path.join(tmpDir, "transactions.json"));
    expect(logger2.getAll()).toHaveLength(1);
  });

  it("exports CSV with headers", () => {
    logger.log(sampleEntry);
    const csv = logger.exportCSV();
    const lines = csv.split("\n");
    expect(lines[0]).toContain("timestamp");
    expect(lines[0]).toContain("type");
    expect(lines[0]).toContain("tokenIn");
    expect(lines[1]).toContain("deposit");
    expect(lines[1]).toContain("USDC");
  });

  it("handles multiple entries", () => {
    logger.log(sampleEntry);
    logger.log({ ...sampleEntry, type: "swap", tokenOut: "wBTC", amountOut: "0.05" });
    expect(logger.getAll()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// mapContextToTxType tests (from tx-processor.test.ts)
// ---------------------------------------------------------------------------

describe("mapContextToTxType", () => {
  it.each([
    ["deploy_funds", "deposit"],
    ["rebalance", "rebalance"],
    ["claim_rewards", "claim_reward"],
    ["cash_out", "cash_out_btc"],
    ["withdraw", "withdraw"],
    ["swap_eth", "swap"],
    ["check_balances", "swap"],
    ["unknown", "swap"],
    ["something_random", "swap"],
    ["", "swap"],
  ])("maps '%s' to '%s'", (input, expected) => {
    expect(mapContextToTxType(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// parseAmountFromOutput tests (from tx-processor.test.ts)
// ---------------------------------------------------------------------------

describe("parseAmountFromOutput", () => {
  it("parses integer amount with USDC", () => {
    const result = parseAmountFromOutput("Deposited 100 USDC into vault");
    expect(result).toEqual({ amount: "100", token: "USDC" });
  });

  it("parses decimal amount with USDC", () => {
    const result = parseAmountFromOutput("Swapped 50.5 USDC for ETH");
    expect(result).toEqual({ amount: "50.5", token: "USDC" });
  });

  it("parses small ETH amount", () => {
    const result = parseAmountFromOutput("Transferred 0.001 ETH to bridge");
    expect(result).toEqual({ amount: "0.001", token: "ETH" });
  });

  it("parses WETH", () => {
    const result = parseAmountFromOutput("Wrapped 1.5 WETH");
    expect(result).toEqual({ amount: "1.5", token: "WETH" });
  });

  it("parses wBTC", () => {
    const result = parseAmountFromOutput("Received 0.05 wBTC");
    expect(result).toEqual({ amount: "0.05", token: "wBTC" });
  });

  it("parses WBTC (uppercase)", () => {
    const result = parseAmountFromOutput("Received 0.1 WBTC from swap");
    expect(result).toEqual({ amount: "0.1", token: "WBTC" });
  });

  it("parses BTC", () => {
    const result = parseAmountFromOutput("Cashed out 0.02 BTC");
    expect(result).toEqual({ amount: "0.02", token: "BTC" });
  });

  it("parses cbBTC", () => {
    const result = parseAmountFromOutput("Deposited 0.5 cbBTC into Morpho");
    expect(result).toEqual({ amount: "0.5", token: "cbBTC" });
  });

  it("returns null for unparseable output", () => {
    expect(parseAmountFromOutput("No amounts here")).toBeNull();
    expect(parseAmountFromOutput("Just some random text")).toBeNull();
    expect(parseAmountFromOutput("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseProtocolFromOutput tests (from tx-processor.test.ts)
// ---------------------------------------------------------------------------

describe("parseProtocolFromOutput", () => {
  it("extracts protocol after 'into'", () => {
    expect(parseProtocolFromOutput("Deposited into Morpho vault")).toBe("Morpho");
  });

  it("extracts protocol after 'from'", () => {
    expect(parseProtocolFromOutput("Withdrew from Aave pool")).toBe("Aave");
  });

  it("extracts protocol after 'via'", () => {
    expect(parseProtocolFromOutput("Swapped via Sushi router")).toBe("Sushi");
  });

  it("extracts protocol after 'on'", () => {
    expect(parseProtocolFromOutput("Staked on Lido")).toBe("Lido");
  });

  it("returns undefined for no match", () => {
    expect(parseProtocolFromOutput("No protocol mentioned")).toBeUndefined();
    expect(parseProtocolFromOutput("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseUsdValueFromOutput tests (from tx-processor.test.ts)
// ---------------------------------------------------------------------------

describe("parseUsdValueFromOutput", () => {
  it("extracts integer USD value", () => {
    expect(parseUsdValueFromOutput("Worth $100 at time of tx")).toBe(100);
  });

  it("extracts decimal USD value", () => {
    expect(parseUsdValueFromOutput("Value: $100.50")).toBe(100.5);
  });

  it("extracts large USD value", () => {
    expect(parseUsdValueFromOutput("Total $12345.67 deposited")).toBe(12345.67);
  });

  it("returns 0 for no match", () => {
    expect(parseUsdValueFromOutput("No dollar sign here")).toBe(0);
    expect(parseUsdValueFromOutput("")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isErc20ApprovOrTransfer tests
// ---------------------------------------------------------------------------

describe("isErc20ApprovOrTransfer", () => {
  it("detects ERC20 approve selector", () => {
    // approve(address,uint256) = 0x095ea7b3
    const data = "0x095ea7b3000000000000000000000000vaultaddr0000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    expect(isErc20ApprovOrTransfer(data)).toBe(true);
  });

  it("detects ERC20 transfer selector", () => {
    // transfer(address,uint256) = 0xa9059cbb
    const data = "0xa9059cbb000000000000000000000000recipient00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003e8";
    expect(isErc20ApprovOrTransfer(data)).toBe(true);
  });

  it("returns false for vault deposit calldata", () => {
    // deposit(uint256,address) = 0x6e553f65
    const data = "0x6e553f65000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000recipient0000000000000000000000000000000000";
    expect(isErc20ApprovOrTransfer(data)).toBe(false);
  });

  it("returns false for undefined data", () => {
    expect(isErc20ApprovOrTransfer(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isErc20ApprovOrTransfer("")).toBe(false);
  });

  it("is case-insensitive", () => {
    const data = "0x095EA7B3000000000000000000000000abcdef";
    expect(isErc20ApprovOrTransfer(data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// processCapturedTxs tests (from tx-processor.test.ts)
// ---------------------------------------------------------------------------

describe("processCapturedTxs", () => {
  function makeMockLogger() {
    return {
      log: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
    } as unknown as TxLogger & { log: ReturnType<typeof vi.fn> };
  }

  const baseTx: CapturedTx = {
    hash: "0xabc123",
    to: "0xvaultAddress",
    context: "deploy_funds",
    timestamp: "2026-03-07T00:00:00.000Z",
  };

  it("calls txLogger.log for each captured tx", () => {
    const mockLogger = makeMockLogger();
    const txs: CapturedTx[] = [
      baseTx,
      { ...baseTx, hash: "0xdef456", context: "rebalance" },
    ];

    processCapturedTxs(txs, mockLogger, "Deposited 100 USDC into Morpho worth $100");

    expect(mockLogger.log).toHaveBeenCalledTimes(2);
  });

  it("maps context to correct tx type", () => {
    const mockLogger = makeMockLogger();
    processCapturedTxs([baseTx], mockLogger, "Deposited 100 USDC into Morpho worth $100");

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ type: "deposit" }),
    );
  });

  it("parses amount and token from LLM output", () => {
    const mockLogger = makeMockLogger();
    processCapturedTxs([baseTx], mockLogger, "Deposited 50.5 USDC into Morpho");

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ tokenIn: "USDC", amountIn: "50.5" }),
    );
  });

  it("parses protocol from LLM output", () => {
    const mockLogger = makeMockLogger();
    processCapturedTxs([baseTx], mockLogger, "Deposited 100 USDC into Morpho");

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: "Morpho" }),
    );
  });

  it("parses USD value from LLM output", () => {
    const mockLogger = makeMockLogger();
    processCapturedTxs([baseTx], mockLogger, "Deposited 100 USDC worth $500.25");

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ usdValueAtTime: 500.25 }),
    );
  });

  it("sets vault to the tx 'to' address", () => {
    const mockLogger = makeMockLogger();
    processCapturedTxs([baseTx], mockLogger, "Deposited 100 USDC");

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ vault: "0xvaultAddress" }),
    );
  });

  it("sets txHash from the captured tx", () => {
    const mockLogger = makeMockLogger();
    processCapturedTxs([baseTx], mockLogger, "Deposited 100 USDC");

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "0xabc123" }),
    );
  });

  it("uses fallback values when LLM output is unparseable", () => {
    const mockLogger = makeMockLogger();
    processCapturedTxs([baseTx], mockLogger, "Something happened");

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenIn: "unknown",
        amountIn: "0",
        usdValueAtTime: 0,
      }),
    );
  });

  it("does nothing for empty captured array", () => {
    const mockLogger = makeMockLogger();
    processCapturedTxs([], mockLogger, "Deposited 100 USDC");

    expect(mockLogger.log).not.toHaveBeenCalled();
  });

  it("skips ERC20 approve txs detected from calldata", () => {
    const mockLogger = makeMockLogger();
    const approveTx: CapturedTx = {
      ...baseTx,
      to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      data: "0x095ea7b3000000000000000000000000spender00000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    };
    processCapturedTxs([approveTx], mockLogger, "Approved 100 USDC");

    expect(mockLogger.log).not.toHaveBeenCalled();
  });

  it("skips ERC20 transfer txs detected from calldata", () => {
    const mockLogger = makeMockLogger();
    const transferTx: CapturedTx = {
      ...baseTx,
      to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      data: "0xa9059cbb000000000000000000000000recipient00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003e8",
    };
    processCapturedTxs([transferTx], mockLogger, "Transferred 100 USDC");

    expect(mockLogger.log).not.toHaveBeenCalled();
  });

  it("processes vault interaction txs even to token contract addresses", () => {
    const mockLogger = makeMockLogger();
    // A vault deposit tx that happens to go to a token address but has vault deposit calldata
    const vaultTx: CapturedTx = {
      ...baseTx,
      to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      data: "0x6e553f65000000000000000000000000000000000000000000000000000000000000000a",
    };
    processCapturedTxs([vaultTx], mockLogger, "Deposited 100 USDC into Morpho");

    expect(mockLogger.log).toHaveBeenCalledTimes(1);
  });
});
