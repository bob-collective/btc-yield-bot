type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatMessage(level: LogLevel, _tag: string, args: unknown[]): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const prefix = `${hh}:${mm} [${level}]`;
  return [prefix, ...args.map(a => (typeof a === "string" ? a : JSON.stringify(a)))].join(" ");
}

export function createLogger(tag: string) {
  return {
    debug(...args: unknown[]) {
      if (shouldLog("debug")) console.debug(formatMessage("debug", tag, args));
    },
    info(...args: unknown[]) {
      if (shouldLog("info")) console.info(formatMessage("info", tag, args));
    },
    warn(...args: unknown[]) {
      if (shouldLog("warn")) console.warn(formatMessage("warn", tag, args));
    },
    error(...args: unknown[]) {
      if (shouldLog("error")) console.error(formatMessage("error", tag, args));
    },
  };
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// --- Unified notification ---
let telegramInstance: { alert: (msg: string) => Promise<void> } | null = null;
const notifyLog = createLogger("Notify");

export function setTelegram(bot: { alert: (msg: string) => Promise<void> }): void {
  telegramInstance = bot;
}

/** Log at the given level AND send to Telegram if level >= warn. */
export function notify(level: LogLevel, message: string): void {
  switch (level) {
    case "debug": notifyLog.debug(message); break;
    case "info": notifyLog.info(message); break;
    case "warn": notifyLog.warn(message); break;
    case "error": notifyLog.error(message); break;
  }
  if ((level === "warn" || level === "error") && telegramInstance) {
    telegramInstance.alert(message).catch(() => {});
  }
}
