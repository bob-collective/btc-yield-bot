import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TransactionRequest, PublicClient } from "viem";

// Mock the logger module
vi.mock("../notify", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock @coinbase/agentkit to avoid pulling in real dependencies.
// We provide a minimal EvmWalletProvider stub that can be extended.
vi.mock("@coinbase/agentkit", () => {
  class WalletProvider {}
  class EvmWalletProvider extends WalletProvider {}
  return { EvmWalletProvider };
});

import {
  InstrumentedWalletProvider,
  type CapturedTx,
} from "../modules/instrumented-wallet";

/**
 * Build a mock inner wallet provider with all methods stubbed.
 */
function createMockInner() {
  return {
    getAddress: vi.fn().mockReturnValue("0xABCD"),
    getNetwork: vi.fn().mockReturnValue({
      protocolFamily: "evm",
      networkId: "base-mainnet",
      chainId: "8453",
    }),
    getName: vi.fn().mockReturnValue("mock_wallet"),
    getBalance: vi.fn().mockResolvedValue(100n),
    nativeTransfer: vi.fn().mockResolvedValue("0xtxNative"),
    sign: vi.fn().mockResolvedValue("0xsig"),
    signMessage: vi.fn().mockResolvedValue("0xsigMsg"),
    signTypedData: vi.fn().mockResolvedValue("0xsigTyped"),
    signTransaction: vi.fn().mockResolvedValue("0xsigTx"),
    sendTransaction: vi.fn().mockResolvedValue("0xtx123"),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    readContract: vi.fn().mockResolvedValue(42n),
    getPublicClient: vi.fn().mockReturnValue({} as PublicClient),
    getUsdcBalance: vi.fn().mockResolvedValue(5_000_000n),
    toSigner: vi.fn().mockReturnValue({}),
  } as any;
}

describe("InstrumentedWalletProvider", () => {
  let inner: ReturnType<typeof createMockInner>;
  let wallet: InstrumentedWalletProvider;

  beforeEach(() => {
    inner = createMockInner();
    wallet = new InstrumentedWalletProvider(inner);
  });

  // -----------------------------------------------------------------------
  // sendTransaction captures and delegates
  // -----------------------------------------------------------------------
  describe("sendTransaction", () => {
    it("delegates to inner and captures the tx", async () => {
      const tx: TransactionRequest = {
        to: "0xRecipient",
        value: 1000n,
        data: "0xabcd",
      };

      const hash = await wallet.sendTransaction(tx);

      expect(hash).toBe("0xtx123");
      expect(inner.sendTransaction).toHaveBeenCalledWith(tx);

      const captured = wallet.drainTxs();
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        hash: "0xtx123",
        to: "0xRecipient",
        value: 1000n,
        context: "unknown",
      });
      expect(captured[0].timestamp).toBeDefined();
    });

    it("captures tx with undefined value when not provided", async () => {
      const tx: TransactionRequest = { to: "0xTarget" };
      await wallet.sendTransaction(tx);

      const captured = wallet.drainTxs();
      expect(captured[0].to).toBe("0xTarget");
      expect(captured[0].value).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // drainTxs clears the buffer
  // -----------------------------------------------------------------------
  describe("drainTxs", () => {
    it("returns all captured txs and clears the buffer", async () => {
      await wallet.sendTransaction({ to: "0xA", value: 1n });
      await wallet.sendTransaction({ to: "0xB", value: 2n });

      const first = wallet.drainTxs();
      expect(first).toHaveLength(2);

      const second = wallet.drainTxs();
      expect(second).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Context management
  // -----------------------------------------------------------------------
  describe("context", () => {
    it("defaults to 'unknown'", () => {
      expect(wallet.getContext()).toBe("unknown");
    });

    it("captures txs with the correct context after setContext", async () => {
      wallet.setContext("deposit");
      await wallet.sendTransaction({ to: "0xA" });

      wallet.setContext("swap");
      await wallet.sendTransaction({ to: "0xB" });

      const txs = wallet.drainTxs();
      expect(txs[0].context).toBe("deposit");
      expect(txs[1].context).toBe("swap");
    });
  });

  // -----------------------------------------------------------------------
  // nativeTransfer routes through sendTransaction for capture
  // -----------------------------------------------------------------------
  describe("nativeTransfer", () => {
    it("nativeTransfer routes through sendTransaction for capture", async () => {
      const result = await wallet.nativeTransfer("0xTo", "500");
      // Routes through our sendTransaction (which calls inner.sendTransaction), not inner.nativeTransfer
      expect(result).toBe("0xtx123");
      expect(inner.sendTransaction).toHaveBeenCalledWith({
        to: "0xTo",
        value: 500n,
      });
      // Should be captured in buffer
      const txs = wallet.drainTxs();
      expect(txs).toHaveLength(1);
      expect(txs[0].to).toBe("0xTo");
      expect(txs[0].value).toBe(500n);
    });
  });
});
