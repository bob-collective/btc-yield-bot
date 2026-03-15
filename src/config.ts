import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// --- Paths (from paths.ts) ---
export const DATA_DIR = path.resolve(process.cwd(), "data");
export const TX_LOG_PATH = path.join(DATA_DIR, "transactions.json");
export const STATE_PATH = path.join(DATA_DIR, "agent-state.json");
export const PROTOCOL_REGISTRY_PATH = path.join(DATA_DIR, "protocol-registry.json");
export const LOG_PATH = path.join(DATA_DIR, "agent.log");
export const CONFIG_PATH = path.resolve(process.cwd(), "config.json");

// --- JSON file helpers (from utils/fs.ts) ---
export function readJsonFile<T = unknown>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- Environment validation (from env.ts) ---
const EnvSchema = z.object({
  PRIVATE_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  VAULTSFYI_API_KEY: z.string().optional(),
  NETWORK_ID: z.string().default("base-mainnet"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  RPC_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cachedEnv: Env | null = null;
export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = EnvSchema.parse(process.env);
  }
  return cachedEnv;
}

// --- Config file schema ---
export const ConfigSchema = z.object({
  btcCashOutAddress: z.string().min(1, "btcCashOutAddress is required"),
  evmWalletAddress: z.string().optional(),
  usdcSplitPercent: z.number().min(0).max(100).default(70),
  profitThresholdUsd: z.number().nonnegative().default(500),
  rebalanceIntervalHours: z.number().positive().default(6),
  minSwapAmountUsd: z.number().positive().default(100),
  maxVaultAllocationPercent: z.number().min(1).max(100).default(100),
  minVaultTvlUsd: z.number().positive().default(100000),
  gasReserveUsdc: z.number().nonnegative().default(5),
});

export type AgentConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath?: string): AgentConfig {
  const filePath = configPath || CONFIG_PATH;
  const parsed = readJsonFile(filePath);
  if (parsed === undefined) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  return ConfigSchema.parse(parsed);
}

export function saveConfig(config: AgentConfig, configPath?: string): void {
  writeJsonFile(configPath || CONFIG_PATH, config);
}
