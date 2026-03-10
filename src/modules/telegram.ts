import { createLogger, safeErrorMessage } from "../notify";
import type { TransactionEntry } from "./transactions";
import { ProfitTracker } from "./portfolio";
import { ConfigSchema } from "../config";

const log = createLogger("Telegram");

const SAFE_CONFIG_KEYS = [
  "profitThresholdUsd",
  "rebalanceIntervalHours",
  "minSwapAmountUsd",
  "maxVaultAllocationPercent",
  "minVaultTvlUsd",
  "usdcSplitPercent",
  "gasReserveUsdc",
];

export interface TelegramBotConfig {
  botToken?: string;
  chatId?: string;
}

export interface TelegramCommandContext {
  loadConfig: () => any;
  saveConfig: (config: any) => void;
  getTxLogger: () => { getAll: () => TransactionEntry[] };
  getProfitTracker: () => ProfitTracker;
  getWalletAddress: () => string;
  runAgentTask: (prompt: string) => Promise<string>;
  triggerCashOut: () => Promise<void>;
}

export class TelegramBot {
  private bot: any | null = null;
  private chatId: string | null = null;
  private enabled: boolean = false;
  private paused: boolean = false;
  private pollingErrorLogged: boolean = false;
  private pendingSetKey: string | null = null;

  constructor(config?: TelegramBotConfig) {
    if (config?.botToken && config?.chatId) {
      this.chatId = config.chatId;
      this.enabled = true;
      // Lazy-load node-telegram-bot-api to avoid crash when not installed
      try {
        const TgBot = require("node-telegram-bot-api");
        this.bot = new TgBot(config.botToken, { polling: true });
        this.bot.on("polling_error", (err: Error) => {
          if (!this.pollingErrorLogged) {
            log.warn("Telegram polling error (further occurrences suppressed):", safeErrorMessage(err));
            this.pollingErrorLogged = true;
          }
        });
      } catch {
        log.warn(
          "node-telegram-bot-api not available, bot instance disabled but alerts configured"
        );
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  async alert(message: string): Promise<void> {
    if (!this.enabled || !this.bot || !this.chatId) return;
    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      log.error("Failed to send alert:", safeErrorMessage(err));
    }
  }

  registerCommands(ctx: TelegramCommandContext): void {
    if (!this.enabled || !this.bot) return;

    this.bot.setMyCommands([
      { command: "status", description: "Portfolio, profit & agent status" },
      { command: "txlog", description: "Recent transactions" },
      { command: "config", description: "Current configuration" },
      { command: "set", description: "Update config value" },
      { command: "pause", description: "Pause agent" },
      { command: "resume", description: "Resume agent" },
      { command: "cashout", description: "Trigger manual cash-out" },
    ]);

    // Handle inline keyboard callbacks for /set
    this.bot.on("callback_query", async (query: any) => {
      if (!query.data?.startsWith("set:")) return;
      if (String(query.message?.chat?.id) !== this.chatId) return;
      const key = query.data.slice(4);
      if (!SAFE_CONFIG_KEYS.includes(key)) return;
      this.pendingSetKey = key;
      await this.bot.answerCallbackQuery(query.id);
      await this.alert(`Send the new value for *${key}*:`);
    });

    this.bot.on("message", (msg: any) => {
      if (!msg?.chat?.id) return;
      // Only respond to the configured chat
      if (String(msg.chat.id) !== this.chatId) return;

      const text = (msg.text || "").trim();

      // Handle pending /set value input
      if (this.pendingSetKey && !text.startsWith("/")) {
        const key = this.pendingSetKey;
        this.pendingSetKey = null;
        const value = text.trim();
        const config = ctx.loadConfig();
        (config as any)[key] = parseFloat(value);
        const result = ConfigSchema.safeParse(config);
        if (!result.success) {
          this.alert(`Invalid value for ${key}: ${result.error.issues[0].message}`).catch((err) => {
            log.error("Failed to send alert:", safeErrorMessage(err));
          });
          return;
        }
        ctx.saveConfig(result.data);
        this.alert(`Updated *${key}* = ${value}\nTakes effect next cycle.`).catch((err) => {
          log.error("Failed to send alert:", safeErrorMessage(err));
        });
        return;
      }

      if (!text.startsWith("/")) return;

      const [cmd, ...args] = text.split(/\s+/);
      this.handleCommand(cmd, args, ctx).catch((err) => {
        log.error("Unhandled command error:", safeErrorMessage(err));
      });
    });
  }

  private async handleCommand(
    cmd: string,
    args: string[],
    ctx: TelegramCommandContext
  ): Promise<void> {
    try {
      switch (cmd) {
        case "/start":
        case "/help": {
          const config = ctx.loadConfig();
          const walletAddress = ctx.getWalletAddress();
          const bobUrl = `https://app.gobob.xyz/en/swap?output-asset=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&output-chain=8453&receive=${walletAddress}`;
          await this.alert(
            `*BTC Yield Agent*\n\n` +
              `Farms DeFi yields on Base, sweeps profits back as BTC.\n\n` +
              `*Smart wallet:*\n[${walletAddress}](https://basescan.org/address/${walletAddress})\n\n` +
              `*Fund via BOB Gateway:*\n${bobUrl}\n\n` +
              `*BTC cash-out:*\n[${config.btcCashOutAddress}](https://mempool.space/address/${config.btcCashOutAddress})\n\n` +
              `*Commands:*\n` +
              `/status — portfolio & profit\n` +
              `/txlog — recent transactions\n` +
              `/config — current configuration\n` +
              `/set <key> <value> — update config\n` +
              `/pause / /resume — pause/resume agent\n` +
              `/cashout — trigger manual cash-out`
          );
          break;
        }
        case "/status":
        case "/profit": {
          const entries = ctx.getTxLogger().getAll();
          const profit = ctx.getProfitTracker();
          const status = this.paused ? "Paused" : "Running";
          const totalFunding = profit.getTotalFunding(entries);
          const cashedOut = profit.getTotalCashedOut(entries);
          const remainingPrincipal = profit.getRemainingPrincipal(entries);

          try {
            const prompt =
              `Report my current portfolio status for Telegram.\n` +
              `List all vault positions with USD balances and APY.\n` +
              `List wallet token balances (USDC, ETH).\n` +
              `Report total portfolio value.\n\n` +
              `Financial context:\n` +
              `- Total funded: $${totalFunding.toFixed(2)}\n` +
              `- Total cashed out: $${cashedOut.toFixed(2)} (BTC)\n` +
              `- Remaining principal: $${remainingPrincipal.toFixed(2)}\n\n` +
              `Calculate unrealized P&L as: total portfolio value minus remaining principal.\n` +
              `Format as a concise summary. No markdown headers, just plain text with line breaks.`;

            const agentResponse = await ctx.runAgentTask(prompt);
            await this.alert(`*BTC Yield Agent — ${status}*\n\n${agentResponse}`);
          } catch (err) {
            log.error("Status command failed:", safeErrorMessage(err));
            await this.alert(`*BTC Yield Agent — ${status}*\n\n(portfolio unavailable)`);
          }
          break;
        }
        case "/txlog": {
          const limit = parseInt(args[0]) || 10;
          const entries = ctx.getTxLogger().getAll().slice(-limit);
          if (entries.length === 0) {
            await this.alert("No transactions yet.");
          } else {
            const lines = entries.map(
              (e: any) =>
                `${e.timestamp.slice(0, 16)} | ${e.type} | $${e.usdValueAtTime}`
            );
            await this.alert(
              `*Last ${entries.length} transactions:*\n\`\`\`\n${lines.join("\n")}\n\`\`\``
            );
          }
          break;
        }
        case "/config": {
          const config = ctx.loadConfig();
          const lines = Object.entries(config)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n");
          await this.alert(`*Config:*\n\`\`\`\n${lines}\n\`\`\``);
          break;
        }
        case "/set": {
          if (args.length < 2) {
            const keyboard = SAFE_CONFIG_KEYS.map(k => [{ text: k, callback_data: `set:${k}` }]);
            await this.bot.sendMessage(this.chatId, "Select a setting to change:", {
              reply_markup: { inline_keyboard: keyboard },
            });
            break;
          }
          const [key, ...valueParts] = args;
          const value = valueParts.join(" ");
          if (!SAFE_CONFIG_KEYS.includes(key)) {
            await this.alert(
              `Cannot set '${key}' remotely.\nAllowed: ${SAFE_CONFIG_KEYS.join(", ")}`
            );
            break;
          }
          const config = ctx.loadConfig();
          (config as any)[key] = parseFloat(value);
          const result = ConfigSchema.safeParse(config);
          if (!result.success) {
            await this.alert(`Invalid value: ${result.error.issues[0].message}`);
            break;
          }
          ctx.saveConfig(result.data);
          await this.alert(
            `Updated *${key}* = ${value}\nTakes effect next cycle.`
          );
          break;
        }
        case "/pause": {
          this.paused = true;
          await this.alert("Agent paused. Current cycle will finish, then skip future checks.\nUse /resume to continue.");
          break;
        }
        case "/resume": {
          this.paused = false;
          await this.alert("Agent resumed.");
          break;
        }
        case "/cashout": {
          await this.alert("Triggering manual cash-out...");
          try {
            await ctx.triggerCashOut();
            await this.alert("Cash-out complete.");
          } catch (err) {
            await this.alert(`Cash-out failed: ${safeErrorMessage(err)}`);
          }
          break;
        }
        default:
          await this.alert(
            `Unknown command: ${cmd}\nAvailable: /status /txlog /config /set /pause /resume /cashout`
          );
      }
    } catch (err) {
      await this.alert(`Command error: ${safeErrorMessage(err)}`);
    }
  }

  stop(): void {
    if (this.bot) {
      try {
        this.bot.stopPolling();
      } catch (err) {
        log.warn("Error stopping polling:", safeErrorMessage(err));
      }
    }
  }
}
