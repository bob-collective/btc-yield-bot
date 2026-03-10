import { type PublicClient, parseAbiItem } from "viem";
import type { TxLogger } from "./transactions";
import { createLogger } from "../notify";

const log = createLogger("FundingMonitor");

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const MIN_FUNDING_USD = 0.5;
const LOOKBACK_BLOCKS = 1000n; // ~30min on Base (2s blocks)

export class FundingMonitor {
  private publicClient: PublicClient;
  private walletAddress: `0x${string}`;
  private txLogger: TxLogger;
  private lastScannedBlock = 0n;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private pendingTxHashes = new Set<string>();

  /** Register a tx hash initiated by the bot so it won't be classified as funding. */
  registerPendingHash(hash: string): void {
    this.pendingTxHashes.add(hash.toLowerCase());
  }

  constructor(
    publicClient: PublicClient,
    walletAddress: string,
    txLogger: TxLogger,
  ) {
    this.publicClient = publicClient;
    this.walletAddress = walletAddress.toLowerCase() as `0x${string}`;
    this.txLogger = txLogger;
  }

  async start(intervalMs = 30_000): Promise<void> {
    const currentBlock = await this.publicClient.getBlockNumber();
    this.lastScannedBlock =
      currentBlock > LOOKBACK_BLOCKS ? currentBlock - LOOKBACK_BLOCKS : 0n;

    await this.scan();

    this.timer = setInterval(() => {
      this.scan().catch((err) => {
        log.error("Scan failed:", String(err));
      });
    }, intervalMs);

    log.info(
      `Started (every ${intervalMs / 1000}s, lookback from block ${this.lastScannedBlock})`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Build set of vault addresses the bot has interacted with (deposit/withdraw entries). */
  private getKnownVaultAddresses(): Set<string> {
    const vaults = new Set<string>();
    for (const entry of this.txLogger.getAll()) {
      if ((entry.type === "deposit" || entry.type === "withdraw" || entry.type === "rebalance") && entry.vault) {
        vaults.add(entry.vault.toLowerCase());
      }
    }
    // Also exclude the bot's own wallet address (self-transfers)
    vaults.add(this.walletAddress);
    return vaults;
  }

  /** Scan for new incoming USDC transfers and log as funding_received. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;

    try {
      const currentBlock = await this.publicClient.getBlockNumber();
      if (currentBlock <= this.lastScannedBlock) return;

      const logs = await this.publicClient.getLogs({
        address: USDC_ADDRESS as `0x${string}`,
        event: TRANSFER_EVENT,
        args: { to: this.walletAddress },
        fromBlock: this.lastScannedBlock + 1n,
        toBlock: currentBlock,
      });

      const existingHashes = new Set(
        this.txLogger.getAll().map((e) => e.txHash.toLowerCase()),
      );
      // Also exclude tx hashes from bot-initiated transactions
      for (const h of this.pendingTxHashes) {
        existingHashes.add(h);
      }
      const knownVaults = this.getKnownVaultAddresses();

      // Aggregate multiple Transfer events per tx (e.g. BOB Gateway sends 2 transfers in 1 tx)
      const txMap = new Map<
        string,
        { amount: number; from: string }
      >();

      for (const event of logs) {
        const txHash = event.transactionHash;
        if (!txHash || existingHashes.has(txHash.toLowerCase())) continue;

        const from = ((event.args.from as string) ?? "unknown").toLowerCase();

        // Skip transfers from known vault addresses (vault withdrawals, not external funding)
        if (knownVaults.has(from)) {
          log.info(`Skipping USDC transfer from known vault ${from} (tx: ${txHash})`);
          continue;
        }

        const amount =
          Number(event.args.value ?? 0n) / 10 ** USDC_DECIMALS;
        const key = txHash.toLowerCase();

        const existing = txMap.get(key);
        if (existing) {
          existing.amount += amount;
        } else {
          txMap.set(key, {
            amount,
            from,
          });
        }
      }

      for (const [txHash, { amount, from }] of txMap) {
        if (amount < MIN_FUNDING_USD) continue;

        this.txLogger.log({
          type: "funding_received",
          tokenIn: "USDC",
          amountIn: amount.toFixed(6),
          usdValueAtTime: parseFloat(amount.toFixed(2)),
          txHash,
          protocol: "external",
          notes: `Auto-detected incoming USDC from ${from}`,
        });

        existingHashes.add(txHash);
        log.info(`Detected funding: $${amount.toFixed(2)} USDC (tx: ${txHash})`);
      }

      this.lastScannedBlock = currentBlock;
    } finally {
      this.scanning = false;
    }
  }
}
