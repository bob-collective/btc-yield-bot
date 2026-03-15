import { readJsonFile, writeJsonFile } from "../config";
import { createLogger } from "../notify";
import type { CapturedTx, InstrumentedWalletProvider } from "./instrumented-wallet";
import { USDC_BASE_ADDRESS, CIRCLE_PAYMASTER_ADDRESS } from "./circle-paymaster-wallet";

const USDC_DECIMALS = 6;

const log = createLogger("tx-processor");

// ---------------------------------------------------------------------------
// TransactionEntry
// ---------------------------------------------------------------------------

export interface TransactionEntry {
  timestamp: string;
  type: "deposit" | "withdraw" | "swap" | "claim_reward" | "rebalance" | "cash_out_btc" | "funding_received";
  tokenIn: string;
  tokenOut?: string;
  amountIn: string;
  amountOut?: string;
  usdValueAtTime: number;
  txHash: string;
  protocol?: string;
  vault?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// TxLogger
// ---------------------------------------------------------------------------

export class TxLogger {
  private entries: TransactionEntry[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  log(entry: Omit<TransactionEntry, "timestamp">): void {
    const full: TransactionEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(full);
    this.save();
  }

  getAll(): TransactionEntry[] {
    return [...this.entries];
  }

  exportCSV(): string {
    const headers = [
      "timestamp", "type", "tokenIn", "tokenOut", "amountIn",
      "amountOut", "usdValueAtTime", "txHash", "protocol", "vault", "notes",
    ];
    const lines = [headers.join(",")];
    for (const e of this.entries) {
      const row = headers.map((h) => {
        const val = e[h as keyof TransactionEntry];
        if (val === undefined || val === null) return "";
        const str = String(val);
        return str.includes(",") ? `"${str}"` : str;
      });
      lines.push(row.join(","));
    }
    return lines.join("\n");
  }

  exportJSON(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  private load(): void {
    const data = readJsonFile<TransactionEntry[]>(this.filePath);
    if (data) {
      this.entries = data;
    }
  }

  private save(): void {
    writeJsonFile(this.filePath, this.entries);
  }
}

// ---------------------------------------------------------------------------
// Context-to-type mapping & parse helpers
// ---------------------------------------------------------------------------

const CONTEXT_TO_TYPE: Record<string, TransactionEntry["type"]> = {
  deploy_funds: "deposit",
  rebalance: "rebalance",
  claim_rewards: "claim_reward",
  cash_out: "cash_out_btc",
  withdraw: "withdraw",
  swap_eth: "swap",
  check_balances: "swap",
  unknown: "swap",
};

export function mapContextToTxType(context: string): TransactionEntry["type"] {
  return CONTEXT_TO_TYPE[context] ?? "swap";
}

// ---------------------------------------------------------------------------
// ERC20 calldata detection
// ---------------------------------------------------------------------------

/** ERC20 approve(address,uint256) function selector */
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";
/** ERC20 transfer(address,uint256) function selector */
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

/** Returns true if the tx calldata is an ERC20 approve or transfer call. */
export function isErc20ApprovOrTransfer(data?: string): boolean {
  if (!data) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return selector === ERC20_APPROVE_SELECTOR || selector === ERC20_TRANSFER_SELECTOR;
}

// ---------------------------------------------------------------------------
// processCapturedTxs
// ---------------------------------------------------------------------------

/**
 * Process captured txs by fetching on-chain receipts and decoding Transfer events.
 * Replaces the previous LLM-text-parsing approach with exact on-chain data.
 */
export async function processCapturedTxs(
  captured: CapturedTx[],
  txLogger: TxLogger,
  walletProvider: InstrumentedWalletProvider,
  walletAddress: string,
): Promise<void> {
  const wallet = walletAddress.toLowerCase();
  const paymaster = CIRCLE_PAYMASTER_ADDRESS.toLowerCase();
  const usdcAddress = USDC_BASE_ADDRESS.toLowerCase();

  // Fetch all receipts in parallel
  const receipts = await Promise.all(
    captured.map(async (tx) => {
      // Skip ERC20 approve/transfer calls before fetching receipt
      if (isErc20ApprovOrTransfer(tx.data)) {
        return { tx, receipt: null, skipped: true };
      }
      try {
        const receipt = await walletProvider.waitForTransactionReceipt(tx.hash);
        return { tx, receipt, skipped: false };
      } catch (err) {
        log.warn(`Failed to fetch receipt for ${tx.hash}: ${err}`);
        return { tx, receipt: null, skipped: false };
      }
    }),
  );

  for (const { tx, receipt, skipped } of receipts) {
    if (skipped) {
      log.info(`skipping tx ${tx.hash} (ERC20 approve/transfer)`);
      continue;
    }

    let type = mapContextToTxType(tx.context);
    let tokenIn = "unknown";
    let amountIn = "0";
    let usdValue = 0;

    if (receipt?.logs) {
      // Decode ERC20 Transfer events from receipt
      const transfers: Array<{
        token: string;
        from: string;
        to: string;
        amount: bigint;
      }> = [];

      for (const logEntry of receipt.logs) {
        try {
          // Transfer event topic: keccak256("Transfer(address,address,uint256)")
          if (
            logEntry.topics &&
            logEntry.topics.length >= 3 &&
            logEntry.topics[0] ===
              "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
          ) {
            const from = ("0x" + logEntry.topics[1].slice(26)).toLowerCase();
            const to = ("0x" + logEntry.topics[2].slice(26)).toLowerCase();
            const amount = BigInt(logEntry.data);
            transfers.push({
              token: (logEntry.address as string).toLowerCase(),
              from,
              to,
              amount,
            });
          }
        } catch {
          // Skip malformed log entries
        }
      }

      // Filter out Circle Paymaster gas payments
      const relevant = transfers.filter(
        (t) => !(t.token === usdcAddress && t.to === paymaster),
      );

      // Find USDC transfers involving our wallet
      const outgoing = relevant.filter(
        (t) => t.from === wallet && t.token === usdcAddress,
      );
      const incoming = relevant.filter(
        (t) => t.to === wallet && t.token === usdcAddress,
      );

      const outTotal = outgoing.reduce((s, t) => s + t.amount, 0n);
      const inTotal = incoming.reduce((s, t) => s + t.amount, 0n);

      if (outTotal > 0n || inTotal > 0n) {
        tokenIn = "USDC";
        // Use the larger direction for amount
        const netAmount = outTotal > inTotal ? outTotal : inTotal;
        const amountNum = Number(netAmount) / 10 ** USDC_DECIMALS;
        amountIn = amountNum.toFixed(6);
        usdValue = parseFloat(amountNum.toFixed(2));

        // For rebalance context, determine direction from net USDC flow
        if (tx.context === "rebalance") {
          type = inTotal > outTotal ? "withdraw" : "deposit";
        }
      } else {
        // Check for non-USDC transfers (cbBTC, etc.)
        const nonUsdcOut = relevant.filter((t) => t.from === wallet && t.token !== usdcAddress);
        const nonUsdcIn = relevant.filter((t) => t.to === wallet && t.token !== usdcAddress);
        const anyNonUsdc = nonUsdcOut.length > 0 ? nonUsdcOut[0] : nonUsdcIn.length > 0 ? nonUsdcIn[0] : null;
        if (anyNonUsdc) {
          tokenIn = anyNonUsdc.token;
          amountIn = anyNonUsdc.amount.toString();
          // USD value unknown for non-USDC tokens
        }
      }
    }

    txLogger.log({
      type,
      tokenIn,
      amountIn,
      usdValueAtTime: usdValue,
      txHash: tx.hash,
      protocol: undefined,
      vault: tx.to,
    });

    log.info(`processed tx ${tx.hash} as ${type}`);
  }
}
