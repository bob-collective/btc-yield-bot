import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FundingMonitor } from "../modules/funding-monitor";

vi.mock("../notify", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockPublicClient(logs: any[] = [], blockNumber = 2000n) {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(blockNumber),
    getLogs: vi.fn().mockResolvedValue(logs),
  } as any;
}

function createMockTxLogger(existingEntries: any[] = []) {
  return {
    getAll: vi.fn().mockReturnValue(existingEntries),
    log: vi.fn(),
  } as any;
}

const WALLET = "0x65Bc733fc0bb4417A63dE6cc8f7f955985F95e96";

describe("FundingMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("scan", () => {
    it("detects new incoming USDC transfer and logs as funding_received", async () => {
      const logs = [{
        transactionHash: "0xabc123",
        blockNumber: 1500n,
        args: {
          from: "0xsender",
          to: WALLET.toLowerCase(),
          value: 10_000_000n, // 10 USDC (6 decimals)
        },
      }];
      const client = createMockPublicClient(logs);
      const txLogger = createMockTxLogger();
      const monitor = new FundingMonitor(client, WALLET, txLogger);

      await monitor.start(999_999);
      monitor.stop();

      expect(txLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "funding_received",
          tokenIn: "USDC",
          amountIn: "10.000000",
          usdValueAtTime: 10,
          txHash: "0xabc123",
        }),
      );
    });

    it("skips transfers already in tx log (by tx hash)", async () => {
      const logs = [{
        transactionHash: "0xexisting",
        blockNumber: 1500n,
        args: { from: "0xsender", to: WALLET.toLowerCase(), value: 5_000_000n },
      }];
      const client = createMockPublicClient(logs);
      const txLogger = createMockTxLogger([
        { txHash: "0xexisting", type: "funding_received", usdValueAtTime: 5 },
      ]);
      const monitor = new FundingMonitor(client, WALLET, txLogger);

      await monitor.start(999_999);
      monitor.stop();

      expect(txLogger.log).not.toHaveBeenCalled();
    });

    it("skips transfers below minimum threshold", async () => {
      const logs = [{
        transactionHash: "0xtiny",
        blockNumber: 1500n,
        args: { from: "0xsender", to: WALLET.toLowerCase(), value: 100_000n }, // 0.10 USDC
      }];
      const client = createMockPublicClient(logs);
      const txLogger = createMockTxLogger();
      const monitor = new FundingMonitor(client, WALLET, txLogger);

      await monitor.start(999_999);
      monitor.stop();

      expect(txLogger.log).not.toHaveBeenCalled();
    });

    it("aggregates multiple transfers in the same tx", async () => {
      const logs = [
        {
          transactionHash: "0xmulti",
          blockNumber: 1500n,
          args: { from: "0xbridge", to: WALLET.toLowerCase(), value: 500_000n }, // 0.50
        },
        {
          transactionHash: "0xmulti",
          blockNumber: 1500n,
          args: { from: "0xbridge", to: WALLET.toLowerCase(), value: 9_000_000n }, // 9.00
        },
      ];
      const client = createMockPublicClient(logs);
      const txLogger = createMockTxLogger();
      const monitor = new FundingMonitor(client, WALLET, txLogger);

      await monitor.start(999_999);
      monitor.stop();

      expect(txLogger.log).toHaveBeenCalledTimes(1);
      expect(txLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          amountIn: "9.500000",
          usdValueAtTime: 9.5,
        }),
      );
    });

    it("does not scan when current block equals last scanned block", async () => {
      const client = createMockPublicClient([], 1000n);
      const txLogger = createMockTxLogger();
      const monitor = new FundingMonitor(client, WALLET, txLogger);

      // Start sets lastScannedBlock to 0, first scan advances to 1000
      await monitor.start(999_999);
      monitor.stop();

      // Second scan — block hasn't advanced
      await monitor.scan();

      // getLogs called once (from start), not again on second scan
      expect(client.getLogs).toHaveBeenCalledTimes(1);
    });
  });

  describe("start/stop", () => {
    it("starts polling and can be stopped", async () => {
      const client = createMockPublicClient();
      const txLogger = createMockTxLogger();
      const monitor = new FundingMonitor(client, WALLET, txLogger);

      await monitor.start(30_000);

      // Advance timer to trigger one poll
      client.getBlockNumber.mockResolvedValue(3000n);
      await vi.advanceTimersByTimeAsync(30_000);

      monitor.stop();

      // getBlockNumber called: once in start() + once in initial scan() + once in interval scan()
      expect(client.getBlockNumber).toHaveBeenCalledTimes(3);
    });
  });
});
