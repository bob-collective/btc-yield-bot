/**
 * CirclePaymasterWalletProvider
 *
 * A wallet provider that uses a ZeroDev Kernel smart account (via permissionless.js)
 * with Circle Paymaster for paying gas fees in USDC on Base.
 *
 * Circle Paymaster is a fully on-chain, permissionless paymaster (no API keys needed).
 * It uses EIP-2612 permit signatures to authorize USDC spending for gas.
 *
 * EntryPoint v0.7 on Base mainnet.
 */

import { EvmWalletProvider } from "@coinbase/agentkit";
import {
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
  type ReadContractParameters,
  type ReadContractReturnType,
  type TransactionRequest,
  createPublicClient,
  encodePacked,
  getContract,
  http,
  maxUint256,
  parseErc6492Signature,
} from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base } from "viem/chains";
import { toEcdsaKernelSmartAccount } from "permissionless/accounts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Circle Paymaster v0.7 on Base mainnet */
export const CIRCLE_PAYMASTER_ADDRESS: Address =
  "0x6C973eBe80dCD8660841D4356bf15c32460271C9";

/** USDC token contract on Base mainnet */
export const USDC_BASE_ADDRESS: Address =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Default max USDC to authorize per user-operation for gas (1 USDC = 1_000_000 units) */
const DEFAULT_MAX_GAS_USDC = 1_000_000n; // 1 USDC

/** Default Pimlico bundler RPC for Base mainnet */
const DEFAULT_BUNDLER_RPC = `https://public.pimlico.io/v2/${base.id}/rpc`;

/** Paymaster verification gas limit */
const PAYMASTER_VERIFICATION_GAS_LIMIT = 200_000n;

/** Paymaster post-op gas limit */
const PAYMASTER_POST_OP_GAS_LIMIT = 60_000n;

// ---------------------------------------------------------------------------
// USDC ABI (minimal, for permit + balance checks)
// ---------------------------------------------------------------------------

export const USDC_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "nonces",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "version",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "permit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CirclePaymasterWalletConfig {
  /** Private key for the EOA signer. If omitted a fresh key is generated. */
  privateKey?: Hex;
  /** Optional RPC URL for the Base public client. Defaults to base chain default. */
  rpcUrl?: string;
  /** Optional bundler RPC URL. Defaults to Pimlico public endpoint. */
  bundlerRpcUrl?: string;
  /** Max USDC (atomic, 6 decimals) to authorize per user-op for gas. Default 1 USDC. */
  maxGasUsdc?: bigint;
  /** Kernel smart account version. Default "0.3.1". */
  kernelVersion?: "0.3.0-beta" | "0.3.1";
  /** Pre-computed smart account address (for recovering existing accounts). */
  address?: Address;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class CirclePaymasterWalletProvider extends EvmWalletProvider {
  readonly #publicClient: PublicClient;
  readonly #smartAccount: Awaited<ReturnType<typeof toEcdsaKernelSmartAccount>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly #bundlerClient: any;
  readonly #address: Address;
  readonly #maxGasUsdc: bigint;

  // -----------------------------------------------------------------------
  // Private constructor — use static `create()` factory
  // -----------------------------------------------------------------------
  private constructor(
    publicClient: PublicClient,
    smartAccount: Awaited<ReturnType<typeof toEcdsaKernelSmartAccount>>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bundlerClient: any,
    address: Address,
    maxGasUsdc: bigint,
  ) {
    super();
    this.#publicClient = publicClient;
    this.#smartAccount = smartAccount;
    this.#bundlerClient = bundlerClient;
    this.#address = address;
    this.#maxGasUsdc = maxGasUsdc;
  }

  // -----------------------------------------------------------------------
  // Static factory
  // -----------------------------------------------------------------------

  /**
   * Create a new CirclePaymasterWalletProvider.
   *
   * This sets up:
   * 1. An EOA signer (from the provided or generated private key)
   * 2. A Kernel v0.3.1 smart account on Base via permissionless.js
   * 3. A bundler client wired to Circle Paymaster via EIP-2612 permit flow
   */
  static async create(
    config: CirclePaymasterWalletConfig = {},
  ): Promise<CirclePaymasterWalletProvider> {
    const privateKey = config.privateKey ?? generatePrivateKey();
    const owner = privateKeyToAccount(privateKey);
    const maxGasUsdc = config.maxGasUsdc ?? DEFAULT_MAX_GAS_USDC;
    const kernelVersion = config.kernelVersion ?? "0.3.1";

    // 1. Public client for Base
    const publicClient = createPublicClient({
      chain: base,
      transport: config.rpcUrl ? http(config.rpcUrl) : http(),
    });

    // 2. Kernel smart account (EntryPoint v0.7)
    const smartAccount = await toEcdsaKernelSmartAccount({
      client: publicClient,
      owners: [owner],
      version: kernelVersion,
      entryPoint: {
        address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address,
        version: "0.7",
      },
      ...(config.address ? { address: config.address } : {}),
    });

    const smartAccountAddress = smartAccount.address;

    // 3. Build the bundler client with Circle Paymaster middleware
    const bundlerRpcUrl = config.bundlerRpcUrl ?? DEFAULT_BUNDLER_RPC;

    const bundlerClient = createBundlerClient({
      account: smartAccount,
      client: publicClient,
      transport: http(bundlerRpcUrl),
      paymaster: {
        async getPaymasterData(parameters) {
          // Sign a USDC EIP-2612 permit for the paymaster to spend gas
          const paymasterData = await buildCirclePaymasterData({
            smartAccount,
            publicClient,
            ownerAddress: smartAccountAddress,
            maxGasUsdc,
          });

          return {
            paymaster: CIRCLE_PAYMASTER_ADDRESS,
            paymasterData,
            paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS_LIMIT,
            paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS_LIMIT,
          };
        },
        async getPaymasterStubData(parameters) {
          // Use real permit signature for stub too — dummy signatures cause
          // gas estimation to fail because the paymaster's safeTransferFrom
          // reverts when the permit doesn't set an allowance.
          const paymasterData = await buildCirclePaymasterData({
            smartAccount,
            publicClient,
            ownerAddress: smartAccountAddress,
            maxGasUsdc,
          });

          return {
            paymaster: CIRCLE_PAYMASTER_ADDRESS,
            paymasterData,
            paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS_LIMIT,
            paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS_LIMIT,
          };
        },
      },
    });

    return new CirclePaymasterWalletProvider(
      publicClient as PublicClient,
      smartAccount,
      bundlerClient,
      smartAccountAddress,
      maxGasUsdc,
    );
  }

  // -----------------------------------------------------------------------
  // EvmWalletProvider abstract method implementations
  // -----------------------------------------------------------------------

  /** Sign a raw hash via the smart account. */
  async sign(hash: `0x${string}`): Promise<`0x${string}`> {
    if (!this.#smartAccount.sign) {
      throw new Error("Smart account does not support raw hash signing");
    }
    return this.#smartAccount.sign({ hash });
  }

  /** Sign a message via the smart account (ERC-1271 compatible). */
  async signMessage(message: string | Uint8Array): Promise<`0x${string}`> {
    const msg =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(message);
    return this.#smartAccount.signMessage({ message: msg });
  }

  /** Sign typed data via the smart account (ERC-1271 compatible). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signTypedData(typedData: any): Promise<`0x${string}`> {
    return this.#smartAccount.signTypedData(typedData);
  }

  /**
   * signTransaction is not supported for smart accounts.
   * Smart accounts use UserOperations, not raw signed transactions.
   */
  async signTransaction(_transaction: TransactionRequest): Promise<`0x${string}`> {
    throw new Error(
      "signTransaction is not supported for CirclePaymasterWalletProvider. " +
      "Smart accounts use UserOperations instead of raw signed transactions.",
    );
  }

  /**
   * Send a transaction through the bundler as a UserOperation.
   * Gas is paid in USDC via Circle Paymaster.
   */
  async sendTransaction(transaction: TransactionRequest): Promise<`0x${string}`> {
    const userOpHash = await this.#bundlerClient.sendUserOperation({
      account: this.#smartAccount,
      calls: [
        {
          to: transaction.to as Address,
          value: transaction.value ? BigInt(transaction.value) : 0n,
          data: (transaction.data as Hex) ?? "0x",
        },
      ],
    });

    // Wait for the user operation to be included
    const receipt = await this.#bundlerClient.waitForUserOperationReceipt({
      hash: userOpHash,
    });

    return receipt.receipt.transactionHash as `0x${string}`;
  }

  /** Wait for a transaction receipt. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async waitForTransactionReceipt(txHash: `0x${string}`): Promise<any> {
    return this.#publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  /** Read from a contract. */
  async readContract<
    const abi extends Abi | readonly unknown[],
    functionName extends ContractFunctionName<abi, "pure" | "view">,
    const args extends ContractFunctionArgs<abi, "pure" | "view", functionName>,
  >(
    params: ReadContractParameters<abi, functionName, args>,
  ): Promise<ReadContractReturnType<abi, functionName, args>> {
    return this.#publicClient.readContract<abi, functionName, args>(params);
  }

  /** Get the underlying Viem PublicClient. */
  getPublicClient(): PublicClient {
    return this.#publicClient;
  }

  // -----------------------------------------------------------------------
  // WalletProvider abstract method implementations
  // -----------------------------------------------------------------------

  /** Get the smart account address. */
  getAddress(): string {
    return this.#address;
  }

  /** Get the network info (Base mainnet). */
  getNetwork() {
    return {
      protocolFamily: "evm" as const,
      networkId: "base-mainnet",
      chainId: String(base.id),
    };
  }

  /** Get the name of this wallet provider. */
  getName(): string {
    return "circle_paymaster_wallet_provider";
  }

  /** Get the native (ETH) balance on Base. */
  async getBalance(): Promise<bigint> {
    return this.#publicClient.getBalance({ address: this.#address });
  }

  /** Transfer native ETH. Routes through the bundler (gas paid in USDC). */
  async nativeTransfer(to: string, value: string): Promise<string> {
    const txHash = await this.sendTransaction({
      to: to as Address,
      value: BigInt(value),
    });
    return txHash;
  }

  // -----------------------------------------------------------------------
  // Additional helpers
  // -----------------------------------------------------------------------

  /** Get the smart account's USDC balance. */
  async getUsdcBalance(): Promise<bigint> {
    return this.#publicClient.readContract({
      address: USDC_BASE_ADDRESS,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [this.#address],
    });
  }

  /** Get the underlying smart account object. */
  getSmartAccount() {
    return this.#smartAccount;
  }

  /** Get the bundler client. */
  getBundlerClient() {
    return this.#bundlerClient;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the paymasterData for Circle Paymaster v0.7.
 *
 * The data is: encodePacked(uint8 reserved, address token, uint256 maxCost, bytes permitSig)
 *
 * The permit signature authorizes the paymaster to spend USDC from the smart account
 * to cover gas costs. This uses EIP-2612 permit (gasless approval).
 */
// Cache USDC metadata (name/version never change)
let cachedTokenName: string | null = null;
let cachedTokenVersion: string | null = null;

async function buildCirclePaymasterData({
  smartAccount,
  publicClient,
  ownerAddress,
  maxGasUsdc,
}: {
  smartAccount: Awaited<ReturnType<typeof toEcdsaKernelSmartAccount>>;
  publicClient: PublicClient;
  ownerAddress: Address;
  maxGasUsdc: bigint;
}): Promise<Hex> {
  const usdc = getContract({
    address: USDC_BASE_ADDRESS,
    abi: USDC_ABI,
    client: publicClient,
  });

  // Read permit nonce (changes per op) and cache token metadata (constant)
  const nonce = await usdc.read.nonces([ownerAddress]);
  if (!cachedTokenName || !cachedTokenVersion) {
    [cachedTokenName, cachedTokenVersion] = await Promise.all([
      usdc.read.name(),
      usdc.read.version(),
    ]);
  }
  const tokenName = cachedTokenName;
  const tokenVersion = cachedTokenVersion;

  // EIP-2612 permit typed data
  const permitTypedData = {
    domain: {
      name: tokenName,
      version: tokenVersion,
      chainId: base.id,
      verifyingContract: USDC_BASE_ADDRESS,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit" as const,
    message: {
      owner: ownerAddress,
      spender: CIRCLE_PAYMASTER_ADDRESS,
      value: maxGasUsdc,
      nonce,
      deadline: maxUint256,
    },
  };

  // Smart account signs the permit (will be ERC-6492 wrapped)
  const wrappedSig = await smartAccount.signTypedData(permitTypedData);

  // Unwrap ERC-6492 signature to get the raw permit signature
  let permitSignature: Hex;
  try {
    const parsed = parseErc6492Signature(wrappedSig);
    permitSignature = parsed.signature;
  } catch {
    // If not ERC-6492 wrapped, use as-is
    permitSignature = wrappedSig;
  }

  // Pack: reserved(0) | usdcAddress | maxCost | permitSignature
  return encodePacked(
    ["uint8", "address", "uint256", "bytes"],
    [0, USDC_BASE_ADDRESS, maxGasUsdc, permitSignature],
  );
}
