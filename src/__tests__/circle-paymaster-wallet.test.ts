import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heavy dependencies so tests don't hit the network
vi.mock("viem", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
      readContract: vi.fn().mockResolvedValue(500000n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        transactionHash: "0xtxhash",
      }),
    })),
  };
});

vi.mock("viem/account-abstraction", () => ({
  createBundlerClient: vi.fn(() => ({
    sendUserOperation: vi.fn().mockResolvedValue("0xuserophash"),
    waitForUserOperationReceipt: vi.fn().mockResolvedValue({
      receipt: { transactionHash: "0xbundledtxhash" },
    }),
  })),
}));

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: "0xOwnerAddress",
    signMessage: vi.fn(),
    signTypedData: vi.fn(),
  })),
  generatePrivateKey: vi.fn(
    () =>
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  ),
}));

vi.mock("permissionless/accounts", () => ({
  toEcdsaKernelSmartAccount: vi.fn().mockResolvedValue({
    address: "0xSmartAccountAddress",
    sign: vi.fn().mockResolvedValue("0xsignature"),
    signMessage: vi.fn().mockResolvedValue("0xmsgsig"),
    signTypedData: vi.fn().mockResolvedValue("0xtypedsig"),
  }),
}));

describe("CirclePaymasterWalletProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Behavioral tests ---

  it("create() returns a provider with the smart account address", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create({
      privateKey:
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    });
    expect(provider.getAddress()).toBe("0xSmartAccountAddress");
  });

  it("create() generates a key when none provided", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const { generatePrivateKey } = await import("viem/accounts");
    await CirclePaymasterWalletProvider.create();
    expect(generatePrivateKey).toHaveBeenCalled();
  });

  it("getNetwork() returns Base mainnet info", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create();
    const network = provider.getNetwork();
    expect(network.protocolFamily).toBe("evm");
    expect(network.networkId).toBe("base-mainnet");
    expect(network.chainId).toBe("8453");
  });

  it("sendTransaction routes through bundler client", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create();
    const txHash = await provider.sendTransaction({
      to: "0xRecipient" as `0x${string}`,
      value: 0n,
      data: "0x" as `0x${string}`,
    });
    expect(txHash).toBe("0xbundledtxhash");
  });

  it("signTransaction throws (smart accounts use UserOps)", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create();
    await expect(
      provider.signTransaction({ to: "0x1234" as `0x${string}` })
    ).rejects.toThrow("signTransaction is not supported");
  });

  it("sign() delegates to smart account", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create();
    const sig = await provider.sign("0xabcdef" as `0x${string}`);
    expect(sig).toBe("0xsignature");
  });

  it("signMessage() delegates to smart account", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create();
    const sig = await provider.signMessage("hello");
    expect(sig).toBe("0xmsgsig");
  });

  it("signTypedData() delegates to smart account", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create();
    const sig = await provider.signTypedData({
      domain: {},
      types: {},
      primaryType: "Test",
      message: {},
    });
    expect(sig).toBe("0xtypedsig");
  });

  it("getBalance() returns native ETH balance", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create();
    const balance = await provider.getBalance();
    expect(balance).toBe(1000000000000000000n);
  });

  it("getUsdcBalance() reads USDC balance from contract", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create();
    const balance = await provider.getUsdcBalance();
    expect(balance).toBe(500000n);
  });

  it("nativeTransfer() sends ETH through bundler", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create();
    const txHash = await provider.nativeTransfer(
      "0xRecipient",
      "1000000000000000000"
    );
    expect(txHash).toBe("0xbundledtxhash");
  });

  it("waitForTransactionReceipt() delegates to public client", async () => {
    const { CirclePaymasterWalletProvider } = await import(
      "../modules/circle-paymaster-wallet"
    );
    const provider = await CirclePaymasterWalletProvider.create();
    const receipt = await provider.waitForTransactionReceipt(
      "0xtxhash" as `0x${string}`
    );
    expect(receipt.status).toBe("success");
  });

});
