/**
 * InstrumentedWalletProvider
 *
 * Wraps any EvmWalletProvider. Intercepts `sendTransaction` to buffer every
 * tx hash + basic params (to, value) with a context label.
 * Delegates all other methods to the inner provider.
 */

import { EvmWalletProvider } from "@coinbase/agentkit";
import type {
  Abi,
  ContractFunctionArgs,
  ContractFunctionName,
  PublicClient,
  ReadContractParameters,
  ReadContractReturnType,
  TransactionRequest,
} from "viem";
import { createLogger } from "../notify";

const log = createLogger("instrumented-wallet");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapturedTx {
  hash: string;
  to: string;
  value?: bigint;
  data?: string;
  context: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class InstrumentedWalletProvider extends EvmWalletProvider {
  readonly #inner: EvmWalletProvider;
  #context: string = "unknown";
  #buffer: CapturedTx[] = [];

  /** Optional callback invoked whenever a tx is captured. */
  onTxCaptured?: (hash: string) => void;

  constructor(inner: EvmWalletProvider) {
    super();
    this.#inner = inner;
  }

  // -----------------------------------------------------------------------
  // Context management
  // -----------------------------------------------------------------------

  setContext(context: string): void {
    this.#context = context;
  }

  getContext(): string {
    return this.#context;
  }

  // -----------------------------------------------------------------------
  // Buffer access
  // -----------------------------------------------------------------------

  /**
   * Returns all captured txs and clears the buffer.
   */
  drainTxs(): CapturedTx[] {
    const txs = this.#buffer;
    this.#buffer = [];
    return txs;
  }

  // -----------------------------------------------------------------------
  // sendTransaction — capture + delegate
  // -----------------------------------------------------------------------

  async sendTransaction(transaction: TransactionRequest): Promise<`0x${string}`> {
    const hash = await this.#inner.sendTransaction(transaction);

    const captured: CapturedTx = {
      hash,
      to: transaction.to as string,
      value: transaction.value != null ? BigInt(transaction.value) : undefined,
      data: transaction.data as string | undefined,
      context: this.#context,
      timestamp: new Date().toISOString(),
    };

    this.#buffer.push(captured);
    log.info(
      `tx captured [${captured.context}]: ${captured.hash} -> ${captured.to}`,
    );

    // Notify listener (e.g. FundingMonitor) about this tx hash
    this.onTxCaptured?.(hash);

    return hash;
  }

  // -----------------------------------------------------------------------
  // Delegated EvmWalletProvider abstract methods
  // -----------------------------------------------------------------------

  async sign(hash: `0x${string}`): Promise<`0x${string}`> {
    return this.#inner.sign(hash);
  }

  async signMessage(message: string | Uint8Array): Promise<`0x${string}`> {
    return this.#inner.signMessage(message);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signTypedData(typedData: any): Promise<`0x${string}`> {
    return this.#inner.signTypedData(typedData);
  }

  async signTransaction(transaction: TransactionRequest): Promise<`0x${string}`> {
    return this.#inner.signTransaction(transaction);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async waitForTransactionReceipt(txHash: `0x${string}`): Promise<any> {
    return this.#inner.waitForTransactionReceipt(txHash);
  }

  async readContract<
    const abi extends Abi | readonly unknown[],
    functionName extends ContractFunctionName<abi, "pure" | "view">,
    const args extends ContractFunctionArgs<abi, "pure" | "view", functionName>,
  >(
    params: ReadContractParameters<abi, functionName, args>,
  ): Promise<ReadContractReturnType<abi, functionName, args>> {
    return this.#inner.readContract<abi, functionName, args>(params);
  }

  getPublicClient(): PublicClient {
    return this.#inner.getPublicClient();
  }

  // -----------------------------------------------------------------------
  // Delegated WalletProvider abstract methods
  // -----------------------------------------------------------------------

  getAddress(): string {
    return this.#inner.getAddress();
  }

  getNetwork() {
    return this.#inner.getNetwork();
  }

  getName(): string {
    return this.#inner.getName();
  }

  async getBalance(): Promise<bigint> {
    return this.#inner.getBalance();
  }

  async nativeTransfer(to: string, value: string): Promise<string> {
    // Route through our sendTransaction so the tx gets captured
    return this.sendTransaction({
      to: to as `0x${string}`,
      value: BigInt(value),
    });
  }

  // -----------------------------------------------------------------------
  // CirclePaymasterWalletProvider extras
  // -----------------------------------------------------------------------

  /**
   * Forward getUsdcBalance() from CirclePaymasterWalletProvider.
   * If the inner provider doesn't have this method, throws.
   */
  async getUsdcBalance(): Promise<bigint> {
    const inner = this.#inner as EvmWalletProvider & {
      getUsdcBalance?: () => Promise<bigint>;
    };
    if (typeof inner.getUsdcBalance !== "function") {
      throw new Error(
        "Inner wallet provider does not support getUsdcBalance()",
      );
    }
    return inner.getUsdcBalance();
  }
}
