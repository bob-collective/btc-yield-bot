# BTC Yield Agent

Farms DeFi yields on Base using USDC (funded from your BTC via [BOB Gateway](https://docs.gobob.xyz/gateway/overview)), then sweeps profits back to your BTC wallet.

**EXPERIMENTAL SOFTWARE** — not production-ready, will contain bugs. Not financial advice. Only deposit what you can afford to lose.

## Quick Start

```bash
git clone --recursive <repo-url>
cd btc-yield-agent
pnpm install
pnpm -s configure
pnpm -s start
```

> If you already cloned without `--recursive`, run `git submodule update --init` before `pnpm install`.

## How It Works

```
BTC → [BOB Gateway](https://docs.gobob.xyz/gateway/overview) → USDC on Base → DeFi vaults → profits → USDC → wBTC → [BOB Gateway](https://docs.gobob.xyz/gateway/overview) → BTC to your wallet
```

1. You fund the agent by sending BTC through [BOB Gateway](https://docs.gobob.xyz/gateway/overview), which delivers USDC to the agent's smart wallet on Base.
2. The agent discovers the best yields via DeFiLlama and deploys funds via vaults.fyi.
3. Every cycle (default 6h), the agent checks positions, rebalances if worthwhile, and claims rewards.
4. When accumulated profit exceeds your threshold, the agent converts to wBTC and sends it to your BTC address via [BOB Gateway](https://docs.gobob.xyz/gateway/overview).

## Bootstrapping

The agent's smart wallet address is generated instantly during setup — no funds or on-chain transaction needed. Just send USDC to the address via [BOB Gateway](https://docs.gobob.xyz/gateway/overview). The smart wallet contract deploys automatically on the first transaction, with gas paid in USDC.

You never need ETH on Base. The agent pays all transaction fees from its own USDC balance via Circle Paymaster (an on-chain, permissionless gas payment contract). The cost is the gas fee plus a 10% surcharge — fractions of a cent per transaction on Base.

## Security Model

- **Your BTC is safe.** The agent sends profits TO your BTC address. It never has access to your BTC wallet. Even if the agent server is fully compromised, your BTC stays safe.
- **EVM wallet.** The agent's Base wallet uses a local private key stored in `.env`. The key is auto-generated during setup. **Back up your `.env` file — if you lose it, you lose access to the smart wallet and any funds in it.**
- **Server security.** Your `.env` file contains the wallet private key and API keys (Anthropic, vaults.fyi). Secure your server. If compromised, an attacker could control the EVM wallet funds (but not your BTC). Rotate keys and move funds immediately if you suspect a breach.

## Requirements

- Node.js 20+
- pnpm (enforced — `npm install` will fail)
- Anthropic API key: https://console.anthropic.com
- Vaults.fyi API key: https://docs.vaults.fyi
- A BTC address for cash-out (P2WPKH `bc1q...` recommended, hardware wallet supported)

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| btcCashOutAddress | — | Your BTC address (P2WPKH recommended) |
| evmWalletAddress | — | Agent's smart wallet on Base (auto-populated) |
| profitThresholdUsd | 500 | Profit USD to trigger BTC cash-out |
| rebalanceIntervalHours | 6 | Hours between agent cycles |
| usdcSplitPercent | 70 | % allocated to USDC vs BTC vaults |
| minSwapAmountUsd | 100 | Min USD value to deploy |
| maxVaultAllocationPercent | 50 | Max % in a single vault |
| minVaultTvlUsd | 100,000 | Min vault TVL to consider |
| gasReserveUsdc | 5 | USDC kept in wallet for gas fees |

## Gas Fees

The agent pays its own gas fees in USDC using Circle Paymaster — an on-chain, permissionless smart contract. No ETH needed, no external billing, no gas credits to apply for.

Cost: gas + 10% surcharge. On Base, this is fractions of a cent per transaction. A typical cycle with 5-10 transactions costs < $0.01 in gas.

## Telegram Bot (optional)

Set up during `pnpm -s configure` or add manually:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Commands: `/status`, `/profit`, `/txlog`, `/config`, `/set`, `/pause`, `/resume`, `/cashout`

## LLM Provider

Uses Anthropic (Claude) by default. LangChain abstracts the LLM — swap to OpenAI, Groq, or any provider by changing one line in `agent.ts`.

## Architecture

```
index.ts (scheduler) → agent.ts (LangGraph + Claude) → agentkit action providers →
DeFiLlama (yield discovery) + vaults.fyi (vault deployment) + [BOB Gateway](https://docs.gobob.xyz/gateway/overview) (BTC bridge)

Smart wallet: Kernel v0.3.1 (ERC-4337, permissionless.js)
Gas: Circle Paymaster (USDC, on-chain)
```

## Dependencies

The project uses a [[BOB Gateway](https://docs.gobob.xyz/gateway/overview) fork of agentkit](https://github.com/bob-collective/agentkit/tree/feat/bob-gateway-action-provider) as a git submodule at `vendor/agentkit`. The postinstall script builds it automatically.

## Transaction Log

All transactions logged to `data/transactions.json`.

```bash
pnpm -s export-csv
pnpm -s export-json
```

Fields: timestamp, type, tokens, amounts, USD value, txHash, protocol, vault
