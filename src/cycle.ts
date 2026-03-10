import { createLogger, safeErrorMessage, notify } from "./notify";
import { type AgentConfig } from "./config";
import { TxLogger, processCapturedTxs } from "./modules/transactions";
import { ProfitTracker, discoverVaultYields, getPortfolioValueUsd, type PortfolioValue } from "./modules/portfolio";
import { ProtocolRegistry } from "./modules/protocol-registry";
import { InstrumentedWalletProvider } from "./modules/instrumented-wallet";
import { TelegramBot } from "./modules/telegram";
import { runAgentTask, type TokenUsage, type AgentTaskResult } from "./agent";

const log = createLogger("Cycle");

export interface CycleAgents {
  lightAgent: any;
  heavyAgent: any;
}

export interface CycleResult {
  stepOutputs: string[];
}

export interface CycleTimestamps {
  lastHeartbeat: number;
  lastNoOpNotified: number;
}

/** Run a cycle and send LLM-summarized Telegram notifications. Returns updated timestamps. */
export async function runCycleWithNotify(
  agents: CycleAgents,
  config: AgentConfig,
  txLogger: TxLogger,
  profitTracker: ProfitTracker,
  protocolRegistry: ProtocolRegistry,
  walletProvider: InstrumentedWalletProvider,
  telegram: TelegramBot,
  timestamps: CycleTimestamps,
  vaultsfyiApiKey?: string,
): Promise<CycleTimestamps> {
  if (telegram.isPaused()) {
    log.info("Paused via Telegram. Skipping check.");
    await telegram.alert("Skipped scheduled check (paused).");
    return timestamps;
  }

  const txCountBefore = txLogger.getAll().length;
  const cycleResult = await runCycle(agents, config, txLogger, profitTracker, protocolRegistry, walletProvider, vaultsfyiApiKey);

  const newTxCount = txLogger.getAll().length - txCountBefore;
  const hadActivity = newTxCount > 0;

  // Generate LLM summary
  let summary: string;
  try {
    const cycleId = Date.now().toString();
    const summaryThread = { configurable: { thread_id: `summary-${cycleId}` } };
    const summaryResult = await runAgentTask(
      agents.lightAgent,
      summaryThread,
      `You are writing a Telegram notification for a yield farming agent.
Summarize what happened this cycle in 2-5 lines. Be concise and natural.
Include specific numbers (amounts, APY, protocol names) when relevant.
If nothing happened, write a brief one-liner.
No markdown headers. Use plain text with line breaks.

Step outputs from this cycle:
${cycleResult.stepOutputs.join("\n---\n")}`
    );
    summary = summaryResult.output;
  } catch (err) {
    log.error("Failed to generate cycle summary:", safeErrorMessage(err));
    summary = hadActivity ? "Cycle completed with activity." : "Cycle completed, no action needed.";
  }

  if (hadActivity) {
    await telegram.alert(summary);
    return { lastHeartbeat: Date.now(), lastNoOpNotified: timestamps.lastNoOpNotified };
  }

  // No-op: only notify once per 20 hours
  const hoursSinceLastNoOp = (Date.now() - timestamps.lastNoOpNotified) / (1000 * 60 * 60);
  if (hoursSinceLastNoOp >= 20) {
    await telegram.alert(summary);
    return { lastHeartbeat: Date.now(), lastNoOpNotified: Date.now() };
  }

  log.info("No-op cycle, skipping Telegram notification (already notified today)");
  return { lastHeartbeat: Date.now(), lastNoOpNotified: timestamps.lastNoOpNotified };
}

async function runCycle(
  agents: CycleAgents,
  config: AgentConfig,
  txLogger: TxLogger,
  profitTracker: ProfitTracker,
  protocolRegistry: ProtocolRegistry,
  walletProvider: InstrumentedWalletProvider,
  vaultsfyiApiKey?: string,
): Promise<CycleResult> {
  const { lightAgent, heavyAgent } = agents;

  const cycleId = Date.now().toString();
  const lightThread = { configurable: { thread_id: `light-${cycleId}` } };
  const heavyThread = { configurable: { thread_id: `heavy-${cycleId}` } };

  const cycleUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  function addUsage(result: AgentTaskResult) {
    cycleUsage.inputTokens += result.usage.inputTokens;
    cycleUsage.outputTokens += result.usage.outputTokens;
    cycleUsage.cacheReadTokens += result.usage.cacheReadTokens;
    cycleUsage.cacheWriteTokens += result.usage.cacheWriteTokens;
  }

  const stepOutputs: string[] = [];

  // Portfolio snapshot: wallet USDC + vault positions (API with tx-log fallback)
  let portfolio: PortfolioValue;
  try {
    portfolio = await getPortfolioValueUsd(walletProvider, walletProvider.getAddress(), vaultsfyiApiKey, txLogger.getAll());
  } catch (err) {
    log.error("Failed to get portfolio value:", safeErrorMessage(err));
    portfolio = { walletUsdcUsd: 0, vaultPositionsUsd: 0, activeVaults: [], totalUsd: 0, positionsSource: "none" };
  }

  // Step 1: Check balances (light agent)
  walletProvider.setContext("check_balances");
  const step1Result = await runAgentTask(
    lightAgent,
    lightThread,
    `Check my wallet balances. Report any USDC, wBTC, ETH, and WETH holdings.
     Use get_wallet_details for native ETH and get_balance for USDC and wBTC (WBTC).
     List each token and its balance.`
  );
  addUsage(step1Result);
  const balanceOutput = step1Result.output;

  // Build known-positions context from portfolio snapshot for Steps 3 & 4
  const { activeVaults } = portfolio;
  let knownPositionsContext = "";
  if (activeVaults.length > 0) {
    const posLines = activeVaults.map(
      (v) => `- ${v.protocol}: ~$${(v.totalDeposited - v.totalWithdrawn).toFixed(2)} in vault ${v.vault}`,
    ).join("\n");
    knownPositionsContext = `
IMPORTANT — Known vault positions from transaction log (vaults.fyi API has indexing delay for smart accounts):
${posLines}
If the positions tool returns empty but the above shows active positions, DO NOT re-deploy — funds are already in vaults.
`;
  }

  // Consolidated portfolio summary (wallet + vault positions)
  const posSource = portfolio.positionsSource !== "none" ? ` (source: ${portfolio.positionsSource})` : "";
  const portfolioSummary = activeVaults.length > 0
    ? `\n\nVault positions${posSource}:\n${activeVaults.map(
        (v) => `  ${v.protocol} (${v.vault}): ~$${(v.totalDeposited - v.totalWithdrawn).toFixed(2)}`,
      ).join("\n")}\nEstimated vault total: ~$${portfolio.vaultPositionsUsd.toFixed(2)}`
    : "\n\nVault positions: none";
  const fullPortfolioOutput = balanceOutput + portfolioSummary;
  stepOutputs.push(fullPortfolioOutput);
  log.info(portfolioSummary.trim());

  // Step 2: Discover best yields via vaults.fyi (no LLM)
  log.info("Fetching yield data from vaults.fyi");
  let yieldContext = "";
  if (vaultsfyiApiKey) {
    try {
      const usdcYields = await discoverVaultYields(vaultsfyiApiKey, {
        network: "base",
        asset: "USDC",
        minTvlUsd: config.minVaultTvlUsd,
      });
      const btcYields = await discoverVaultYields(vaultsfyiApiKey, {
        network: "base",
        asset: "cbBTC",
        minTvlUsd: config.minVaultTvlUsd,
      });
      yieldContext = `
## Best USDC Vaults on Base (ranked by 30d APY, highest first):
${usdcYields.summary}

## Best cbBTC Vaults on Base (ranked by 30d APY, highest first):
${btcYields.summary}
`;
      log.info(
        `Found ${usdcYields.vaults.length} USDC vaults and ${btcYields.vaults.length} cbBTC vaults`
      );
    } catch (err) {
      log.error("Failed to fetch vault yields:", safeErrorMessage(err));
      yieldContext = "(Vault yield data unavailable this cycle)";
    }
  } else {
    log.warn("No VAULTSFYI_API_KEY — skipping yield discovery");
    yieldContext = "(No vaults.fyi API key configured — vault discovery unavailable)";
  }

  // Step 3: Deploy idle funds (heavy agent)
  walletProvider.setContext("deploy_funds");
  const step3Result = await runAgentTask(
    heavyAgent,
    heavyThread,
    `Current wallet balances:
${balanceOutput}

Here are the best vaults on Base (ranked by 30d APY, highest first):
${yieldContext}

${protocolRegistry.formatForPrompt()}

Check my current vault positions using the positions tool.
${knownPositionsContext}
If I have idle USDC or wBTC/cbBTC not deployed in vaults, deploy into the best vaults.
The vaults above are ranked by APY (highest first). Pick the top vault where the
Redeem column shows "instant". Use transaction_context and execute_step to deploy.

Rules:
- Always keep at least $${config.gasReserveUsdc} USDC in the wallet as a gas reserve. Never deploy this amount.
- Do not deploy amounts less than $${config.minSwapAmountUsd}.
- Never allocate more than ${config.maxVaultAllocationPercent}% of portfolio to a single vault.
- Only consider vaults with TVL above $${config.minVaultTvlUsd.toLocaleString()}.`
  );
  addUsage(step3Result);
  const step3Output = step3Result.output;
  stepOutputs.push(step3Output);
  processCapturedTxs(walletProvider.drainTxs(), txLogger, step3Output);

  // Step 4: Rebalance (heavy agent)
  walletProvider.setContext("rebalance");
  const step4Result = await runAgentTask(
    heavyAgent,
    heavyThread,
    `Compare my current vault positions against the best available yields shown above.
${knownPositionsContext}
${protocolRegistry.formatForPrompt()}

     If the best available vault has APY more than 1% higher than your current vault, rebalance.
     If the improvement is 1% or less, skip — not worth the churn. Gas on Base is negligible.
     The target vault must have instant withdrawal (redeemStepsType === "instant").
     If rebalancing is worthwhile, execute it using transaction_context and execute_step. Otherwise, skip.`
  );
  addUsage(step4Result);
  const step4Output = step4Result.output;
  stepOutputs.push(step4Output);
  processCapturedTxs(walletProvider.drainTxs(), txLogger, step4Output);

  // Step 5: Claim rewards (light agent)
  walletProvider.setContext("claim_rewards");
  const step5Result = await runAgentTask(
    lightAgent,
    lightThread,
    `Check if any of my vault positions have claimable rewards using rewards_context.
     If there are claimable rewards, claim them.`
  );
  addUsage(step5Result);
  const step5Output = step5Result.output;
  stepOutputs.push(step5Output);
  processCapturedTxs(walletProvider.drainTxs(), txLogger, step5Output);

  // Log cycle token usage (all LLM steps complete)
  log.info(
    `Cycle tokens: ${cycleUsage.inputTokens} input (${cycleUsage.cacheReadTokens} cached) + ${cycleUsage.outputTokens} output`
  );

  // Step 6a: Profit check (code only — no LLM, fresh portfolio snapshot)
  const entries = txLogger.getAll();
  const principalBasis = profitTracker.getRemainingPrincipal(entries);

  let portfolioValueUsd = 0;
  try {
    const freshPortfolio = await getPortfolioValueUsd(walletProvider, walletProvider.getAddress(), vaultsfyiApiKey, entries);
    portfolioValueUsd = freshPortfolio.totalUsd;
  } catch (err) {
    log.error("Failed to get portfolio value for profit check:", safeErrorMessage(err));
    return { stepOutputs };
  }

  const profit = profitTracker.calculateProfit(entries, portfolioValueUsd);
  log.info(`Profit check: portfolio=$${portfolioValueUsd.toFixed(2)}, principal=$${principalBasis.toFixed(2)}, profit=$${profit.toFixed(2)}, threshold=$${config.profitThresholdUsd}`);

  // Forced exit mode: profitThresholdUsd <= 0 means withdraw everything
  const forcedExit = config.profitThresholdUsd <= 0;

  if (!forcedExit && profit <= config.profitThresholdUsd) {
    log.info(`Profit $${profit.toFixed(2)} below threshold $${config.profitThresholdUsd} — skipping cash-out`);
    return { stepOutputs };
  }

  // Step 6b: Cash out
  if (forcedExit) {
    notify("info", `Forced exit mode — withdrawing full portfolio ($${portfolioValueUsd.toFixed(2)})`);
  } else {
    notify("info", `Profit $${profit.toFixed(2)} exceeds threshold $${config.profitThresholdUsd} — executing cash-out`);
  }
  walletProvider.setContext("cash_out");

  const cashOutPrompt = forcedExit
    ? `FORCED EXIT: Withdraw ALL funds from ALL vault positions. Leave nothing in vaults.
     Then:
     1. Check ETH balance — if below 0.0005 ETH, swap ~$1 USDC to native ETH via the Enso route tool
        (tokenOut: 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE)
     2. Use swap_to_btc to send ALL remaining USDC (minus $${config.gasReserveUsdc} gas reserve) directly to ${config.btcCashOutAddress}
     3. Report the exact amounts swapped and the BTC transaction details`
    : `My profit is $${profit.toFixed(2)} (portfolio $${portfolioValueUsd.toFixed(2)} minus principal $${principalBasis.toFixed(2)}).
     This exceeds my cash-out threshold of $${config.profitThresholdUsd}.

     Execute cash-out:
     1. Withdraw approximately $${profit.toFixed(2)} from the lowest-APY vault
     2. Check ETH balance — if below 0.0005 ETH, swap ~$1 USDC to native ETH via the Enso route tool
        (tokenOut: 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE)
     3. Use swap_to_btc to send USDC directly to ${config.btcCashOutAddress}
     4. Report the exact amounts swapped and the BTC transaction details`;

  const step6Result = await runAgentTask(
    heavyAgent,
    heavyThread,
    cashOutPrompt,
  );
  addUsage(step6Result);
  const step6Output = step6Result.output;
  stepOutputs.push(step6Output);
  processCapturedTxs(walletProvider.drainTxs(), txLogger, step6Output);

  return { stepOutputs };
}
