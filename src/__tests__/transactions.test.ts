import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TxLogger,
  TransactionEntry,
  mapContextToTxType,
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
  const TRANSFER_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const WALLET = "0x65Bc733fc0bb4417A63dE6cc8f7f955985F95e96";
  const WALLET_PADDED = "0x00000000000000000000000065bc733fc0bb4417a63de6cc8f7f955985f95e96";
  const VAULT = "0xBEEFFFe68dFc2D3BD1ABdAd37c70634973b16478";
  const VAULT_PADDED = "0x000000000000000000000000beefffe68dfc2d3bd1abdad37c70634973b16478";
  const PAYMASTER_PADDED = "0x0000000000000000000000006c973ebe80dcd8660841d4356bf15c32460271c9";

  function makeMockLogger() {
    return {
      log: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
    } as unknown as TxLogger & { log: ReturnType<typeof vi.fn> };
  }

  function makeTransferLog(
    token: string,
    from: string,
    to: string,
    amount: bigint,
  ) {
    return {
      address: token,
      topics: [TRANSFER_TOPIC, from, to],
      data: "0x" + amount.toString(16).padStart(64, "0"),
    };
  }

  function makeMockWalletProvider(receipt: any) {
    return {
      waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    } as any;
  }

  const baseTx: CapturedTx = {
    hash: "0xabc123" as `0x${string}`,
    to: VAULT,
    context: "deploy_funds",
    timestamp: "2026-03-07T00:00:00.000Z",
  };

  it("decodes USDC deposit from receipt Transfer events", async () => {
    const mockLogger = makeMockLogger();
    const receipt = {
      logs: [
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, VAULT_PADDED, 1000_000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);

    await processCapturedTxs([baseTx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "deposit",
        tokenIn: "USDC",
        amountIn: "1000.000000",
        usdValueAtTime: 1000,
        vault: VAULT,
        txHash: "0xabc123",
      }),
    );
  });

  it("decodes USDC withdraw from receipt Transfer events", async () => {
    const mockLogger = makeMockLogger();
    const receipt = {
      logs: [
        makeTransferLog(USDC_ADDRESS, VAULT_PADDED, WALLET_PADDED, 500_000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);
    const tx = { ...baseTx, context: "rebalance" };

    await processCapturedTxs([tx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "withdraw",
        tokenIn: "USDC",
        amountIn: "500.000000",
        usdValueAtTime: 500,
      }),
    );
  });

  it("filters out Circle Paymaster gas transfers", async () => {
    const mockLogger = makeMockLogger();
    const receipt = {
      logs: [
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, VAULT_PADDED, 100_000000n),
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, PAYMASTER_PADDED, 50000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);

    await processCapturedTxs([baseTx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        amountIn: "100.000000",
        usdValueAtTime: 100,
      }),
    );
  });

  it("skips ERC20 approve txs without fetching receipt", async () => {
    const mockLogger = makeMockLogger();
    const wp = makeMockWalletProvider({});
    const approveTx: CapturedTx = {
      ...baseTx,
      data: "0x095ea7b3000000000000000000000000spender0000000000000000000000000000",
    };

    await processCapturedTxs([approveTx], mockLogger, wp, WALLET);

    expect(mockLogger.log).not.toHaveBeenCalled();
    expect(wp.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("falls back to zero values when receipt fetch fails", async () => {
    const mockLogger = makeMockLogger();
    const wp = {
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    } as any;

    await processCapturedTxs([baseTx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "deposit",
        tokenIn: "unknown",
        amountIn: "0",
        usdValueAtTime: 0,
        txHash: "0xabc123",
      }),
    );
  });

  it("handles native ETH txs with no Transfer events", async () => {
    const mockLogger = makeMockLogger();
    const receipt = { logs: [] };
    const wp = makeMockWalletProvider(receipt);
    const tx = { ...baseTx, context: "cash_out" };

    await processCapturedTxs([tx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cash_out_btc",
        tokenIn: "unknown",
        amountIn: "0",
      }),
    );
  });

  it("determines rebalance deposit from net outgoing USDC", async () => {
    const mockLogger = makeMockLogger();
    const receipt = {
      logs: [
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, VAULT_PADDED, 200_000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);
    const tx = { ...baseTx, context: "rebalance" };

    await processCapturedTxs([tx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ type: "deposit" }),
    );
  });

  it("does nothing for empty captured array", async () => {
    const mockLogger = makeMockLogger();
    const wp = makeMockWalletProvider({});

    await processCapturedTxs([], mockLogger, wp, WALLET);

    expect(mockLogger.log).not.toHaveBeenCalled();
  });

  it("logs non-USDC token transfers with raw amount", async () => {
    const mockLogger = makeMockLogger();
    const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
    const CBBTC_PADDED = "0x000000000000000000000000cbb7c0000ab88b473b1f5afd9ef808440eed33bf";
    const receipt = {
      logs: [
        makeTransferLog(CBBTC, WALLET_PADDED, VAULT_PADDED, 50000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);

    await processCapturedTxs([baseTx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenIn: CBBTC.toLowerCase(),
        amountIn: "50000000",
        usdValueAtTime: 0,
      }),
    );
  });

  it("uses net USDC direction for mixed incoming/outgoing rebalance", async () => {
    const mockLogger = makeMockLogger();
    const OTHER_VAULT_PADDED = "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678";
    const receipt = {
      logs: [
        makeTransferLog(USDC_ADDRESS, OTHER_VAULT_PADDED, WALLET_PADDED, 300_000000n),
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, VAULT_PADDED, 100_000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);
    const tx = { ...baseTx, context: "rebalance" };

    await processCapturedTxs([tx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "withdraw",
        amountIn: "300.000000",
      }),
    );
  });

  it("fetches receipts in parallel", async () => {
    const mockLogger = makeMockLogger();
    const receipt = {
      logs: [
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, VAULT_PADDED, 50_000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);
    const txs = [baseTx, { ...baseTx, hash: "0xdef456" as `0x${string}` }];

    await processCapturedTxs(txs, mockLogger, wp, WALLET);

    expect(wp.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(mockLogger.log).toHaveBeenCalledTimes(2);
  });
});
