import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import { getEnv, loadConfig, saveConfig, DATA_DIR, TX_LOG_PATH, PROTOCOL_REGISTRY_PATH } from "./config";
import {
  CirclePaymasterWalletProvider,
  type CirclePaymasterWalletConfig,
} from "./modules/circle-paymaster-wallet";
import { InstrumentedWalletProvider } from "./modules/instrumented-wallet";
import { createAgents, runAgentTask } from "./agent";
import type { CycleAgents } from "./cycle";
import { TxLogger, processCapturedTxs } from "./modules/transactions";
import { ProfitTracker } from "./modules/portfolio";
import { TelegramBot } from "./modules/telegram";
import { ProtocolRegistry } from "./modules/protocol-registry";
import { FundingMonitor } from "./modules/funding-monitor";
import { createLogger, safeErrorMessage } from "./notify";
import { runCycleWithNotify } from "./cycle";
import * as fs from "fs";
import { type Hex, type Address } from "viem";

const log = createLogger("Main");

async function main() {
  const env = getEnv();
  const config = loadConfig();
  log.info("BTC Yield Agent starting...");

  // Ensure data dir exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Init modules
  const txLogger = new TxLogger(TX_LOG_PATH);
  const profitTracker = new ProfitTracker();
  const protocolRegistry = new ProtocolRegistry(PROTOCOL_REGISTRY_PATH);

  // Create wallet (inlined from former modules/wallet.ts)
  const walletConfig: CirclePaymasterWalletConfig = {
    privateKey: env.PRIVATE_KEY ? (env.PRIVATE_KEY as Hex) : undefined,
    bundlerRpcUrl: undefined,
    rpcUrl: env.RPC_URL,
    address: config.evmWalletAddress ? (config.evmWalletAddress as Address) : undefined,
  };
  const inner = await CirclePaymasterWalletProvider.create(walletConfig);
  const walletProvider = new InstrumentedWalletProvider(inner);
  const walletAddress = walletProvider.getAddress();
  log.info(`Smart wallet: ${walletAddress}`);

  // Persist EVM wallet address to config if not already saved
  if (config.evmWalletAddress !== walletAddress) {
    config.evmWalletAddress = walletAddress;
    saveConfig(config);
  }

  // Init Telegram bot (optional — disabled if env vars not set)
  const telegram = new TelegramBot({
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  });

  // Create agents (light for read-only tasks, heavy for transactions)
  const { lightAgent, heavyAgent, lightThreadConfig, heavyThreadConfig } = await createAgents(walletProvider, config);
  const agents: CycleAgents = { lightAgent, heavyAgent, lightThreadConfig, heavyThreadConfig };

  if (telegram.isEnabled()) {
    telegram.registerCommands({
      loadConfig: () => loadConfig(),
      saveConfig: (c) => saveConfig(c),
      getTxLogger: () => txLogger,
      getProfitTracker: () => profitTracker,
      getWalletAddress: () => walletAddress,
      runAgentTask: async (prompt: string) => {
        const result = await runAgentTask(heavyAgent, heavyThreadConfig, prompt);
        return result.output;
      },
      triggerCashOut: async () => {
        const entries = txLogger.getAll();
        const principal = profitTracker.getRemainingPrincipal(entries);
        walletProvider.setContext("cash_out");
        const result = await runAgentTask(heavyAgent, heavyThreadConfig,
          `Check ETH balance — if below 0.0005 ETH, swap ~$1 USDC to native ETH via the Enso route tool (tokenOut: 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE).
           Then use swap_to_btc to send remaining USDC to ${config.btcCashOutAddress}.
           Report the order ID and transaction hash.`
        );
        processCapturedTxs(walletProvider.drainTxs(), txLogger, result.output);
      },
    });
    log.info("Telegram bot connected");
  }

  // Start funding monitor — scans for incoming USDC transfers every 30s
  const fundingMonitor = new FundingMonitor(
    walletProvider.getPublicClient(),
    walletAddress,
    txLogger,
  );
  await fundingMonitor.start(30_000);

  // Run initial check
  log.info("Running initial portfolio check");
  let lastHeartbeat = 0;
  await runCycleWithNotify(agents, config, txLogger, profitTracker, protocolRegistry, walletProvider, telegram, lastHeartbeat, env.VAULTSFYI_API_KEY)
    .then((t) => { lastHeartbeat = t; });

  // Schedule recurring cycles
  const intervalMs = config.rebalanceIntervalHours * 60 * 60 * 1000;
  log.info(`Next check in ${config.rebalanceIntervalHours}h`);

  const timer = setInterval(async () => {
    log.info("Starting portfolio check");
    try {
      lastHeartbeat = await runCycleWithNotify(
        agents, config, txLogger, profitTracker, protocolRegistry, walletProvider, telegram, lastHeartbeat, env.VAULTSFYI_API_KEY
      );
    } catch (err) {
      log.error("Check failed:", safeErrorMessage(err));
      await telegram.alert(`Check failed: ${safeErrorMessage(err)}. Retrying in ${config.rebalanceIntervalHours}h.`);
    }
    log.info(`Next check in ${config.rebalanceIntervalHours}h`);
  }, intervalMs);

  // Graceful shutdown
  process.on("SIGINT", () => {
    log.info("Shutting down...");
    clearInterval(timer);
    fundingMonitor.stop();
    telegram.stop();
    log.info("Goodbye.");
    process.exit(0);
  });
}

main().catch((err) => {
  log.error("Fatal error:", safeErrorMessage(err));
  process.exit(1);
});
