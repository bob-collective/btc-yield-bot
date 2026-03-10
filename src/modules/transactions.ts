import { readJsonFile, writeJsonFile } from "../config";
import { createLogger } from "../notify";
import type { CapturedTx } from "./instrumented-wallet";

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

/** Best-effort extract amount + token from LLM output text. */
export function parseAmountFromOutput(output: string): { amount: string; token: string } | null {
  const match = output.match(/(\d+\.?\d*)\s+(USDC|ETH|WETH|wBTC|WBTC|BTC|cbBTC)/i);
  if (!match) return null;
  return { amount: match[1], token: match[2] };
}

/** Best-effort extract protocol name from LLM output text. */
export function parseProtocolFromOutput(output: string): string | undefined {
  const match = output.match(/(?:into|from|via|on)\s+(\w+)/i);
  return match?.[1];
}

/** Best-effort extract USD value from LLM output text. */
export function parseUsdValueFromOutput(output: string): number {
  const match = output.match(/\$(\d+\.?\d*)/);
  return match ? parseFloat(match[1]) : 0;
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
 * Process captured txs and write them to the TxLogger.
 * Uses context label for type mapping and LLM output for enrichment.
 * Filters out ERC20 approve/transfer calls (detected from calldata) and resolves
 * rebalance txs into proper withdraw/deposit pairs.
 */
export function processCapturedTxs(
  captured: CapturedTx[],
  txLogger: TxLogger,
  llmOutput: string,
): void {
  // Build set of active vault addresses to distinguish withdraw vs deposit in rebalances
  const activeVaults = new Set(
    txLogger.getAll()
      .filter((e) => e.type === "deposit" && e.vault)
      .map((e) => e.vault!.toLowerCase()),
  );

  const parsed = parseAmountFromOutput(llmOutput);
  const protocol = parseProtocolFromOutput(llmOutput);
  const usdValue = parseUsdValueFromOutput(llmOutput);

  for (const tx of captured) {
    // Skip ERC20 approve/transfer calls (detected from calldata, not hardcoded addresses)
    if (isErc20ApprovOrTransfer(tx.data)) {
      log.info(`skipping tx ${tx.hash} (ERC20 approve/transfer to ${tx.to})`);
      continue;
    }

    let type = mapContextToTxType(tx.context);

    // For rebalance context, determine if this is a withdraw or deposit
    if (tx.context === "rebalance") {
      const isActiveVault = activeVaults.has(tx.to.toLowerCase());
      type = isActiveVault ? "withdraw" : "deposit";
    }

    txLogger.log({
      type,
      tokenIn: parsed?.token ?? "unknown",
      amountIn: parsed?.amount ?? "0",
      usdValueAtTime: usdValue,
      txHash: tx.hash,
      protocol,
      vault: tx.to,
    });

    // After logging a deposit, add it to activeVaults so subsequent rebalance logic works
    if (type === "deposit") {
      activeVaults.add(tx.to.toLowerCase());
    }

    log.info(`processed tx ${tx.hash} as ${type}`);
  }
}
