import * as readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

export function validateBtcAddress(address: string): boolean {
  if (!address || address.length < 20) return false;
  return /^(bc1[qp][a-zA-HJ-NP-Z0-9]{38,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(
    address
  );
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "..." + value.slice(-4);
}

export async function createPromptInterface(): Promise<readline.Interface> {
  return readline.createInterface({ input, output });
}

export async function askRequired(
  rl: readline.Interface,
  question: string
): Promise<string> {
  let answer = "";
  while (!answer.trim()) {
    answer = await rl.question(question);
  }
  return answer.trim();
}

export async function askWithDefault(
  rl: readline.Interface,
  question: string,
  defaultValue: string
): Promise<string> {
  const answer = await rl.question(`${question} [${defaultValue}]: `);
  return answer.trim() || defaultValue;
}

export function printBanner(): void {
  console.log(`
BTC Yield Agent — Setup (6 steps)
====================================
BTC → BOB Gateway → USDC on Base → DeFi vaults → profits → BTC back to you

Your BTC wallet is never accessible by the agent. Gas paid in USDC (no ETH needed).

EXPERIMENTAL SOFTWARE — not production-ready, will contain bugs.
Not financial advice. Only deposit what you can afford to lose.
`);
}

export function printSection(title: string, description: string): void {
  console.log(`\n${title}`);
  console.log(description);
  console.log("");
}
