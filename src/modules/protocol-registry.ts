import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../notify";

const log = createLogger("ProtocolRegistry");

export interface VaultEntry {
  protocol: string;
  symbol: string;
  redeemType: "instant" | "complex";
  checkedAt: string;
}

interface RegistryData {
  vaults: Record<string, VaultEntry>;
}

function makeKey(address: string, network: string): string {
  return `${address.toLowerCase()}:${network}`;
}

export class ProtocolRegistry {
  private data: RegistryData;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): RegistryData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        return { vaults: raw.vaults || {} };
      }
    } catch (err) {
      log.warn("Failed to load protocol registry, starting fresh");
    }
    return { vaults: {} };
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  lookup(address: string, network: string): VaultEntry | undefined {
    return this.data.vaults[makeKey(address, network)];
  }

  add(address: string, network: string, entry: VaultEntry): void {
    this.data.vaults[makeKey(address, network)] = entry;
    this.save();
  }

  isInstant(address: string, network: string): boolean | undefined {
    const entry = this.lookup(address, network);
    if (!entry) return undefined;
    return entry.redeemType === "instant";
  }

  getAll(): Record<string, VaultEntry> {
    return this.data.vaults;
  }

  formatForPrompt(): string {
    const entries = Object.entries(this.data.vaults);
    if (entries.length === 0) return "No vaults in protocol registry yet.";

    const instant = entries.filter(([, v]) => v.redeemType === "instant");
    const complex = entries.filter(([, v]) => v.redeemType === "complex");

    const lines: string[] = ["## Known Vault Withdrawal Types"];

    if (instant.length > 0) {
      lines.push("\n**Instant withdrawal (safe to use):**");
      for (const [key, v] of instant) {
        lines.push(`- ${v.protocol} ${v.symbol} [${v.redeemType}] (${key})`);
      }
    }

    if (complex.length > 0) {
      lines.push("\n**Complex/delayed withdrawal (DO NOT USE):**");
      for (const [key, v] of complex) {
        lines.push(`- ${v.protocol} ${v.symbol} [${v.redeemType}] (${key})`);
      }
    }

    return lines.join("\n");
  }
}
