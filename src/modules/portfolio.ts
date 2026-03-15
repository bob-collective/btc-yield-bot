import { createLogger } from "../notify";
import type { TransactionEntry } from "./transactions";

const log = createLogger("Portfolio");

// ---------------------------------------------------------------------------
// vaults.fyi yield discovery
// ---------------------------------------------------------------------------

const VAULTSFYI_API_V2 = "https://api.vaults.fyi/v2";

export interface VaultsfyiVault {
  protocol: string;
  asset: string;
  address: string;
  apy30dTotal: number;
  apy30dBase: number;
  apy30dReward: number;
  apy1dTotal: number;
  tvlUsd?: number;
  redeemStepsType?: string;
}

export interface VaultYieldFilter {
  network: string;
  asset: string;
  minTvlUsd?: number;
  perPage?: number;
}

function parseVault(v: any): VaultsfyiVault {
  const apy30d = v.apy?.["30day"] ?? {};
  const apy1d = v.apy?.["1day"] ?? {};
  const tvl = v.tvl?.usd ?? v.tvl?.tvlUsd;
  const redeem = v.transactionalProperties?.redeemStepsType ?? v.transactionalSupport?.redeem?.stepsType;
  return {
    protocol: v.protocol?.name ?? "unknown",
    asset: v.asset?.symbol ?? "unknown",
    address: v.address ?? "",
    apy30dTotal: apy30d.total ?? 0,
    apy30dBase: apy30d.base ?? 0,
    apy30dReward: apy30d.reward ?? 0,
    apy1dTotal: apy1d.total ?? 0,
    tvlUsd: tvl != null ? Number(tvl) : undefined,
    redeemStepsType: redeem,
  };
}

export async function fetchVaults(
  apiKey: string,
  filter: VaultYieldFilter,
): Promise<VaultsfyiVault[]> {
  const params = new URLSearchParams({
    allowedNetworks: filter.network,
    allowedAssets: filter.asset,
    onlyTransactional: "true",
    sortBy: "apy30day",
    sortOrder: "desc",
    perPage: String(filter.perPage ?? 15),
  });
  if (filter.minTvlUsd) {
    params.set("minTvl", String(filter.minTvlUsd));
  }

  const res = await fetch(`${VAULTSFYI_API_V2}/detailed-vaults?${params}`, {
    headers: { "X-API-Key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`vaults.fyi API error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const data = json.data ?? json;
  if (!Array.isArray(data)) {
    throw new Error("vaults.fyi API returned unexpected format");
  }
  return data.map(parseVault);
}

export function formatVaultSummary(vaults: VaultsfyiVault[], limit: number = 15): string {
  const top = vaults.slice(0, limit);
  const lines = [
    "| # | Protocol | Asset | 30d APY | 1d APY | Redeem | Address |",
    "|---|----------|-------|---------|--------|--------|---------|",
  ];
  top.forEach((v, i) => {
    const apy30d = `${(v.apy30dTotal * 100).toFixed(2)}%`;
    const apy1d = `${(v.apy1dTotal * 100).toFixed(2)}%`;
    const redeem = v.redeemStepsType ?? "unknown";
    lines.push(
      `| ${i + 1} | ${v.protocol} | ${v.asset} | ${apy30d} | ${apy1d} | ${redeem} | ${v.address} |`
    );
  });
  return lines.join("\n");
}

export async function discoverVaultYields(
  apiKey: string,
  filter: VaultYieldFilter,
): Promise<{ vaults: VaultsfyiVault[]; summary: string }> {
  const vaults = await fetchVaults(apiKey, filter);
  const summary = formatVaultSummary(vaults);
  return { vaults, summary };
}

// ---------------------------------------------------------------------------
// Profit tracking
// ---------------------------------------------------------------------------

export interface VaultHistoryEntry {
  protocol?: string;
  vault: string;
  totalDeposited: number;
  totalWithdrawn: number;
  realizedPnl: number;
  isActive: boolean;
}

export class ProfitTracker {
  /** Sum of usdValueAtTime for all funding_received entries. */
  getTotalFunding(entries: TransactionEntry[]): number {
    return entries
      .filter((e) => e.type === "funding_received")
      .reduce((sum, e) => sum + e.usdValueAtTime, 0);
  }

  /** Sum of usdValueAtTime for all cash_out_btc entries. */
  getTotalCashedOut(entries: TransactionEntry[]): number {
    return entries
      .filter((e) => e.type === "cash_out_btc")
      .reduce((sum, e) => sum + e.usdValueAtTime, 0);
  }

  /** Remaining principal still in the portfolio = total funding minus what was already cashed out. */
  getRemainingPrincipal(entries: TransactionEntry[]): number {
    return this.getTotalFunding(entries) - this.getTotalCashedOut(entries);
  }

  /** Build per-vault history from deposit/withdraw entries that have a protocol. */
  getVaultHistory(entries: TransactionEntry[]): VaultHistoryEntry[] {
    const relevant = entries.filter(
      (e) => (e.type === "deposit" || e.type === "withdraw") && e.vault,
    );

    const vaultMap = new Map<
      string,
      { protocol: string; vault: string; totalDeposited: number; totalWithdrawn: number; lastType: string }
    >();

    for (const entry of relevant) {
      const key = entry.vault!;
      const existing = vaultMap.get(key);

      if (existing) {
        if (entry.type === "deposit") {
          existing.totalDeposited += entry.usdValueAtTime;
        } else {
          existing.totalWithdrawn += entry.usdValueAtTime;
        }
        existing.lastType = entry.type;
      } else {
        vaultMap.set(key, {
          protocol: entry.protocol ?? undefined,
          vault: key,
          totalDeposited: entry.type === "deposit" ? entry.usdValueAtTime : 0,
          totalWithdrawn: entry.type === "withdraw" ? entry.usdValueAtTime : 0,
          lastType: entry.type,
        });
      }
    }

    return Array.from(vaultMap.values()).map(({ protocol, vault, totalDeposited, totalWithdrawn, lastType }) => ({
      protocol,
      vault,
      totalDeposited,
      totalWithdrawn,
      realizedPnl: totalWithdrawn - totalDeposited,
      isActive: totalDeposited - totalWithdrawn > 0.01,
    }));
  }

  /** Unrealized profit = portfolio value minus remaining principal. */
  calculateProfit(entries: TransactionEntry[], currentPortfolioValueUsd: number): number {
    return currentPortfolioValueUsd - this.getRemainingPrincipal(entries);
  }

  /** True when unrealized profit exceeds the given threshold. */
  shouldCashOut(entries: TransactionEntry[], currentPortfolioValueUsd: number, thresholdUsd: number): boolean {
    return this.calculateProfit(entries, currentPortfolioValueUsd) > thresholdUsd;
  }
}

// ---------------------------------------------------------------------------
// Portfolio value query (direct API — no LLM)
// ---------------------------------------------------------------------------

export interface PortfolioValue {
  walletUsdcUsd: number;
  vaultPositionsUsd: number;
  activeVaults: VaultHistoryEntry[];
  totalUsd: number;
  positionsSource: "api" | "tx-log" | "none";
}

/**
 * Queries current portfolio value from wallet USDC balance + vaultsfyi positions.
 * Falls back to transaction-log-based position estimates when the API returns empty.
 * No LLM involved — direct RPC/API reads.
 */
export async function getPortfolioValueUsd(
  walletProvider: { getUsdcBalance: () => Promise<bigint> },
  walletAddress: string,
  vaultsfyiApiKey?: string,
  txEntries?: TransactionEntry[],
): Promise<PortfolioValue> {
  // Wallet USDC balance (6 decimals)
  const usdcBalance = await walletProvider.getUsdcBalance();
  const walletUsdcUsd = Number(usdcBalance) / 1_000_000;

  // Vault positions via vaultsfyi API
  let vaultPositionsUsd = 0;
  let positionsSource: PortfolioValue["positionsSource"] = "none";

  if (vaultsfyiApiKey) {
    try {
      const res = await fetch(`${VAULTSFYI_API_V2}/portfolio/positions/${walletAddress}?allowedNetworks=base`, {
        headers: { "X-API-Key": vaultsfyiApiKey },
      });
      if (res.ok) {
        const json = await res.json();
        const positions = json.data ?? json;
        if (Array.isArray(positions) && positions.length > 0) {
          vaultPositionsUsd = positions.reduce((sum: number, p: any) => {
            const balUsd = parseFloat(p.asset?.balanceUsd ?? "0") || 0;
            return sum + balUsd;
          }, 0);
          positionsSource = "api";
          log.info(`Positions API returned $${vaultPositionsUsd.toFixed(2)}`);
        }
      } else {
        log.warn(`vaultsfyi positions API returned ${res.status}`);
      }
    } catch (err) {
      log.warn("Failed to fetch vaultsfyi positions:", String(err));
    }
  }

  // Always compute active vaults from tx log (needed for agent context + fallback)
  const tracker = new ProfitTracker();
  const activeVaults = txEntries
    ? tracker.getVaultHistory(txEntries).filter((v) => v.isActive)
    : [];

  // Fallback: estimate vault positions from transaction log
  if (vaultPositionsUsd === 0 && activeVaults.length > 0) {
    const txLogEstimate = activeVaults.reduce(
      (sum, v) => sum + Math.max(0, v.totalDeposited - v.totalWithdrawn),
      0,
    );
    if (txLogEstimate > 0) {
      vaultPositionsUsd = txLogEstimate;
      positionsSource = "tx-log";
      log.info(`Positions API empty — using tx-log estimate $${txLogEstimate.toFixed(2)}`);
    }
  }

  const totalUsd = walletUsdcUsd + vaultPositionsUsd;
  return { walletUsdcUsd, vaultPositionsUsd, activeVaults, totalUsd, positionsSource };
}

