import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import * as fs from "fs";
import * as path from "path";
import {
  printBanner,
  printSection,
  askRequired,
  askWithDefault,
  createPromptInterface,
  validateBtcAddress,
  maskSecret,
} from "./setup/prompts";
import { saveConfig, loadConfig, AgentConfig, ConfigSchema } from "./config";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CirclePaymasterWalletProvider,
  type CirclePaymasterWalletConfig,
} from "./modules/circle-paymaster-wallet";
import { InstrumentedWalletProvider } from "./modules/instrumented-wallet";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { USDC_BASE_ADDRESS, USDC_ABI } from "./modules/circle-paymaster-wallet";

const ENV_PATH = path.resolve(process.cwd(), ".env");
const CONFIG_PATH = path.resolve(process.cwd(), "config.json");

/** Parse existing .env file into a key-value map. */
function loadExistingEnv(): Record<string, string> {
  try {
    const content = fs.readFileSync(ENV_PATH, "utf-8");
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) env[match[1]] = match[2];
    }
    return env;
  } catch {
    return {};
  }
}

/** Load existing config.json, returning undefined if missing/invalid. */
function loadExistingConfig(): AgentConfig | undefined {
  try {
    return loadConfig(CONFIG_PATH);
  } catch {
    return undefined;
  }
}

/**
 * Poll Telegram getUpdates until a /start message arrives.
 * First flushes any old updates, then polls for up to 30 seconds.
 */
async function fetchChatId(token: string): Promise<string> {
  const api = `https://api.telegram.org/bot${token}`;
  try {
    // Flush old updates by getting the latest offset
    const flush = await fetch(`${api}/getUpdates`);
    const flushData = (await flush.json()) as {
      ok: boolean;
      result: Array<{ update_id: number; message?: { chat?: { id?: number } } }>;
    };
    let offset = 0;
    if (flushData.ok && flushData.result?.length) {
      offset = flushData.result[flushData.result.length - 1].update_id + 1;
    }

    // Poll for new /start message (30s timeout, 5s long-poll per request)
    const maxAttempts = 6;
    for (let i = 0; i < maxAttempts; i++) {
      process.stdout.write(".");
      const res = await fetch(`${api}/getUpdates?offset=${offset}&timeout=5`);
      const data = (await res.json()) as {
        ok: boolean;
        result: Array<{ update_id: number; message?: { chat?: { id?: number } } }>;
      };
      if (data.ok && data.result?.length) {
        for (const update of data.result) {
          const chatId = update.message?.chat?.id;
          if (chatId) {
            console.log(""); // newline after dots
            return String(chatId);
          }
        }
        offset = data.result[data.result.length - 1].update_id + 1;
      }
    }
    console.log(""); // newline after dots
    return "";
  } catch {
    return "";
  }
}

/** Poll USDC balance on Base until funds arrive. */
async function waitForFunding(address: Address, rpcUrl?: string): Promise<bigint> {
  const client = createPublicClient({
    chain: base,
    transport: rpcUrl ? http(rpcUrl) : http(),
  });
  const maxAttempts = 60; // 10 minutes at 10s intervals
  for (let i = 0; i < maxAttempts; i++) {
    const balance = await client.readContract({
      address: USDC_BASE_ADDRESS,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [address],
    });
    if (balance > 0n) return balance;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return 0n;
}

async function setup() {
  const rl = await createPromptInterface();

  // Load existing settings for re-run
  const existingEnv = loadExistingEnv();
  const existingConfig = loadExistingConfig();
  const isRerun = Object.keys(existingEnv).length > 0 || existingConfig !== undefined;

  printBanner();

  if (isRerun) {
    console.log("Existing configuration detected. Press Enter to keep current values.\n");
  }

  // Step 1: BTC Address
  printSection(
    "1. BTC Cash-Out Address",
    "Where the agent sends BTC profits. P2WPKH (bc1q...) recommended."
  );
  let btcAddress = "";
  const existingBtc = existingConfig?.btcCashOutAddress;
  while (true) {
    let raw: string;
    if (existingBtc) {
      raw = (await rl.question(`BTC address [${existingBtc}]: `)).trim();
      if (!raw) { btcAddress = existingBtc; break; }
    } else {
      raw = await askRequired(rl, "BTC address: ");
    }
    if (validateBtcAddress(raw)) {
      btcAddress = raw;
      console.log(`Verified: https://mempool.space/address/${btcAddress}`);
      break;
    }
    console.log("Invalid address. Enter a valid Bitcoin address (bc1q... recommended).");
  }

  // Step 2: Anthropic
  printSection(
    "2. Anthropic API Key",
    "Powers the AI agent (Claude). Get one at console.anthropic.com"
  );
  let anthropicKey: string;
  const existingAnthropic = existingEnv.ANTHROPIC_API_KEY;
  if (existingAnthropic) {
    const raw = (await rl.question(`Anthropic API Key [${maskSecret(existingAnthropic)}]: `)).trim();
    anthropicKey = raw || existingAnthropic;
  } else {
    anthropicKey = await askRequired(rl, "Anthropic API Key: ");
  }

  // Step 3: Vaults.fyi
  printSection(
    "3. Vaults.fyi API Key",
    "Deploys funds into DeFi vaults. Get one at docs.vaults.fyi"
  );
  let vaultsfyiKey: string;
  const existingVaultsfyi = existingEnv.VAULTSFYI_API_KEY;
  if (existingVaultsfyi) {
    const raw = (await rl.question(`Vaults.fyi API Key [${maskSecret(existingVaultsfyi)}]: `)).trim();
    vaultsfyiKey = raw || existingVaultsfyi;
  } else {
    vaultsfyiKey = await askRequired(rl, "Vaults.fyi API Key: ");
  }

  // Keep existing wallet key or generate a new one
  const privateKey = existingEnv.PRIVATE_KEY || generatePrivateKey();

  // Write .env
  const envLines = [
    `PRIVATE_KEY=${privateKey}`,
    `ANTHROPIC_API_KEY=${anthropicKey}`,
    `VAULTSFYI_API_KEY=${vaultsfyiKey}`,
    `NETWORK_ID=${existingEnv.NETWORK_ID || "base-mainnet"}`,
    `TELEGRAM_BOT_TOKEN=${existingEnv.TELEGRAM_BOT_TOKEN || ""}`,
    `TELEGRAM_CHAT_ID=${existingEnv.TELEGRAM_CHAT_ID || ""}`,
  ];
  fs.writeFileSync(ENV_PATH, envLines.join("\n") + "\n");

  // Step 4: Configuration
  printSection(
    "4. Configuration",
    "Press Enter for defaults."
  );

  console.log("Profit threshold — triggers BTC cash-out when yield exceeds this amount.");
  const profitThreshold = await askWithDefault(
    rl,
    "Profit threshold USD",
    String(existingConfig?.profitThresholdUsd ?? 500)
  );

  console.log("\nRebalance interval — how often the agent checks and rebalances. Lower = more LLM cost.");
  const rebalanceInterval = await askWithDefault(
    rl,
    "Rebalance interval hours",
    String(existingConfig?.rebalanceIntervalHours ?? 6)
  );

  console.log("\nMin swap amount — won't deploy below this. Keeps gas proportional to yield.");
  const minSwapAmount = await askWithDefault(
    rl,
    "Min swap amount USD",
    String(existingConfig?.minSwapAmountUsd ?? 100)
  );

  console.log("\nMax vault allocation — max % in a single vault. Lower = more diversified.");
  const maxVaultAlloc = await askWithDefault(
    rl,
    "Max vault allocation %",
    String(existingConfig?.maxVaultAllocationPercent ?? 50)
  );

  console.log("\nMin vault TVL — only considers vaults above this TVL. Higher = lower rug risk.");
  const minVaultTvl = await askWithDefault(
    rl,
    "Min vault TVL USD",
    String(existingConfig?.minVaultTvlUsd ?? 100000)
  );

  console.log("\nGas reserve — USDC kept in wallet for gas. Smart wallet pays gas in USDC.");
  const gasReserve = await askWithDefault(
    rl,
    "Gas reserve USDC",
    String(existingConfig?.gasReserveUsdc ?? 5)
  );

  // Step 5: Telegram (optional)
  printSection(
    "5. Telegram Bot (optional)",
    "Get alerts and remote control. Create a bot at https://t.me/BotFather\n" +
      "then paste the token below. Setup will auto-detect your Chat ID."
  );
  const existingTelegramToken = existingEnv.TELEGRAM_BOT_TOKEN;
  const existingTelegramChat = existingEnv.TELEGRAM_CHAT_ID;
  let telegramToken: string;
  let telegramChatId: string;
  if (existingTelegramToken) {
    const raw = (await rl.question(`Telegram Bot Token [${maskSecret(existingTelegramToken)}]: `)).trim();
    telegramToken = raw || existingTelegramToken;
  } else {
    telegramToken = (await rl.question("Telegram Bot Token (Enter to skip): ")).trim();
  }
  if (telegramToken) {
    if (existingTelegramChat) {
      const raw = (await rl.question(`Telegram Chat ID [${existingTelegramChat}]: `)).trim();
      telegramChatId = raw || existingTelegramChat;
    } else {
      // Auto-detect Chat ID by polling getUpdates
      console.log("\nSend /start to your bot in Telegram now.");
      console.log("Waiting for message");
      telegramChatId = await fetchChatId(telegramToken);
      if (telegramChatId) {
        console.log(`Detected Chat ID: ${telegramChatId}`);
      } else {
        console.log("Could not auto-detect Chat ID.");
        console.log(`Find it manually: https://api.telegram.org/bot${telegramToken}/getUpdates`);
        console.log("Look for \"chat\":{\"id\":NUMBERS}");
        telegramChatId = (await rl.question("Telegram Chat ID: ")).trim();
      }
    }
  } else {
    telegramChatId = "";
  }

  // Update .env with telegram values
  if (telegramToken || telegramChatId) {
    const envContent = fs.readFileSync(ENV_PATH, "utf-8");
    const updatedEnv = envContent
      .replace(/TELEGRAM_BOT_TOKEN=.*/, `TELEGRAM_BOT_TOKEN=${telegramToken}`)
      .replace(/TELEGRAM_CHAT_ID=.*/, `TELEGRAM_CHAT_ID=${telegramChatId}`);
    fs.writeFileSync(ENV_PATH, updatedEnv);
  }

  // Write config.json (without wallet address yet)
  const config: AgentConfig = ConfigSchema.parse({
    btcCashOutAddress: btcAddress,
    evmWalletAddress: existingConfig?.evmWalletAddress,
    profitThresholdUsd: parseFloat(profitThreshold),
    rebalanceIntervalHours: parseFloat(rebalanceInterval),
    minSwapAmountUsd: parseFloat(minSwapAmount),
    maxVaultAllocationPercent: parseFloat(maxVaultAlloc),
    minVaultTvlUsd: parseFloat(minVaultTvl),
    gasReserveUsdc: parseFloat(gasReserve),
  });
  saveConfig(config);

  // Step 6: Smart Wallet & Funding
  printSection(
    "6. Smart Wallet & Funding",
    "Creating your smart wallet on Base..."
  );

  const isNewKey = !existingEnv.PRIVATE_KEY;
  const eoa = privateKeyToAccount(privateKey as Hex);

  const walletConfig: CirclePaymasterWalletConfig = {
    privateKey: privateKey as Hex,
    bundlerRpcUrl: undefined,
    rpcUrl: undefined,
    address: config.evmWalletAddress
      ? (config.evmWalletAddress as Address)
      : undefined,
  };
  const innerWallet = await CirclePaymasterWalletProvider.create(walletConfig);
  const walletProvider = new InstrumentedWalletProvider(innerWallet);
  const walletAddress = walletProvider.getAddress();

  // Save wallet address to config
  config.evmWalletAddress = walletAddress;
  saveConfig(config);

  if (isNewKey) {
    console.log(`Generated new private key.`);
  } else {
    console.log(`Using existing private key.`);
  }
  console.log(`EOA signer:    https://basescan.org/address/${eoa.address}`);
  console.log(`Smart wallet:  https://basescan.org/address/${walletAddress}`);
  console.log(`Network:       Base (gas paid in USDC)`);

  console.log(`\n⚠️  IMPORTANT: Your private key is stored in .env (PRIVATE_KEY).`);
  console.log(`   If you lose this file, you lose access to all funds in the smart wallet.`);
  console.log(`   Back up .env to a secure location now.\n`);

  const bobGatewayUrl =
    `https://app.gobob.xyz/en/swap?output-asset=${USDC_BASE_ADDRESS}&output-chain=${base.id}&receive=${walletAddress}`;

  console.log(`Fund with BTC via BOB Gateway:`);
  console.log(`${bobGatewayUrl}\n`);

  // Check if already funded
  const existingBalance = await walletProvider.getUsdcBalance();
  if (existingBalance > 0n) {
    const usdcAmount = Number(existingBalance) / 1_000_000;
    console.log(`Wallet already funded: $${usdcAmount.toFixed(2)} USDC\n`);
  } else {
    console.log("Waiting for funds (checking every 10s). Ctrl+C to skip.\n");

    const balance = await waitForFunding(walletAddress as Address);
    if (balance > 0n) {
      const usdcAmount = Number(balance) / 1_000_000;
      console.log(`\nFunds received: $${usdcAmount.toFixed(2)} USDC\n`);
    } else {
      console.log("\nNo funds yet — you can fund later. The agent will pick it up on first run.\n");
    }
  }

  // Summary
  console.log(`============================`);
  console.log(`BTC Yield Agent — Ready`);
  console.log(`============================`);
  console.log(`BTC address:   https://mempool.space/address/${btcAddress}`);
  console.log(`Smart wallet:  https://basescan.org/address/${walletAddress}`);
  console.log(`Anthropic:     ${maskSecret(anthropicKey)}`);
  console.log(`Vaults.fyi:    ${maskSecret(vaultsfyiKey)}`);
  console.log(`Telegram:      ${telegramToken ? "Enabled" : "Disabled"}`);
  console.log(``);
  console.log(`Run: pnpm -s start`);
  console.log(`============================`);

  rl.close();
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
