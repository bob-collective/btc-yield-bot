# btc-yield-agent Design

## Overview

An autonomous yield farming agent on Base that manages an EVM wallet, deploys funds into the best-yielding DeFi vaults, and cashes out profits to BTC.

**Key principle:** The agent controls only an EVM wallet (via CDP). It never holds BTC keys. The user funds the agent's wallet on Base and provides a BTC address for profit cash-outs.

**Constraint:** No modifications to the agentkit codebase. This is a standalone project that imports agentkit as a dependency.

## Lifecycle

```
1. Startup
   Agent creates/loads CDP EVM wallet on Base
   Displays wallet address to user
   User provides BTC destination address
   User funds the agent's wallet (USDC, wBTC, ETH, etc.)

2. Onboarding (on first funding detected)
   Assess received tokens
   Normalize: swap non-yield assets to USDC/wBTC via CDP swap
   Record cost basis at time of receipt

3. Deploy
   Use vaultsfyi to find best vaults for USDC + wBTC on Base
   LLM evaluates APY, TVL, protocol risk
   Deposit into selected vaults via vaultsfyi

4. Recurring cycle (every 6h, configurable)
   Check positions + claimable rewards
   Claim any available rewards
   Compare current vault APYs to alternatives
   Rebalance if LLM decides it's worth it (yield improvement vs gas cost)
   Calculate profit (portfolio value - principal basis)
   If profit > configured threshold:
     Withdraw profit portion from vaults
     Swap to wBTC if needed (via CDP swap)
     swap_to_btc via BOB Gateway → user's BTC address
   Log all transactions

5. On demand
   Export tax report (CSV/JSON)
   Status report (current positions, yields, profit)
```

## Architecture

```
btc-yield-agent/
├── src/
│   ├── index.ts              # Entry point, scheduler
│   ├── agent.ts              # LangGraph agent setup + state graph
│   ├── config.ts             # Config loading + validation
│   ├── modules/
│   │   ├── wallet.ts         # Wallet setup, balance polling, funding detection
│   │   ├── normalizer.ts     # Asset normalization (ETH→USDC, etc.)
│   │   ├── yield-engine.ts   # Vault discovery, evaluation, deployment via vaultsfyi
│   │   ├── rebalancer.ts     # Periodic yield comparison + rebalance decisions
│   │   ├── profit-monitor.ts # Principal tracking, profit calculation, BTC cash-out
│   │   └── tx-logger.ts      # Transaction logging + CSV/JSON export
│   └── prompts/
│       ├── vault-selection.ts    # LLM prompt for vault allocation
│       ├── rebalance-decision.ts # LLM prompt for rebalance evaluation
│       └── status-report.ts     # LLM prompt for portfolio summaries
├── config.json               # User configuration
├── data/
│   └── transactions.json     # Transaction log (persisted)
├── package.json
├── tsconfig.json
└── docs/
    └── plans/
```

## Components

### 1. Wallet & Setup Module (`wallet.ts`)

- Creates or loads a `CdpEvmWalletProvider` on `base-mainnet`
- Persists wallet credentials (encrypted) so the same wallet is used across restarts
- Exposes wallet address for user to fund
- Polls `erc20ActionProvider.get_balance` for USDC, wBTC and `walletActionProvider.get_wallet_details` for native ETH
- Detects new funding by comparing balances to last known state

### 2. Asset Normalizer (`normalizer.ts`)

- On funding detection, assesses what tokens arrived
- Converts non-yield assets to yield-optimal ones:
  - Raw ETH → wrap via `wethActionProvider.wrap_eth` → swap WETH→USDC via `cdpEvmWalletActionProvider.swap`
  - Other ERC20s → swap to USDC via CDP swap
  - wBTC → keep as-is (can yield-farm directly) or swap portion to USDC per `usdcSplitPercent` config
  - USDC → ready to deploy
- Records USD cost basis at time of conversion (using `pythActionProvider` for prices)

### 3. Yield Engine (`yield-engine.ts`)

Uses `vaultsfyiActionProvider` exclusively:

- `vaults` — find best vaults for USDC and wBTC on Base, sorted by APY, filtered by `minVaultTvlUsd`
- `benchmark_apy` — compare vault yields against Base benchmark
- `detailed_vault` + `vault_historical_data` — deep-dive on candidates (APY stability over time)
- LLM evaluates candidates and decides allocation (respecting `maxVaultAllocationPercent`)
- `transaction_context` → `execute_step` to deposit
- `positions` — track current deployments
- `rewards_context` → `claim_rewards` — harvest earned rewards

### 4. Rebalancer (`rebalancer.ts`)

Runs every cycle:

- Fetch current `positions` with APYs
- Fetch current `vaults` list (best available)
- Compare: is there a vault with significantly better APY than current positions?
- LLM decides: "Is moving from Vault A (3.2% APY) to Vault B (5.8% APY) worth the gas + slippage? Portfolio in A is $1000, gas estimate is ~$2."
- If yes: withdraw from A via `execute_step`, deposit to B via `execute_step`
- Enforces `maxVaultAllocationPercent` — won't over-concentrate

### 5. Profit Monitor + BTC Cash-Out (`profit-monitor.ts`)

- Maintains principal basis: total USD value of all assets when first deposited
- Each cycle: sum current portfolio value from `positions` + wallet balances
- Profit = current portfolio value - principal basis
- When profit > `profitThresholdUsd`:
  1. Calculate profit amount to withdraw
  2. Withdraw from vault(s) — prefer withdrawing from lowest-APY vault first
  3. If withdrawn asset is USDC → swap to wBTC via `cdpEvmWalletActionProvider.swap`
  4. `bobGatewayActionProvider.swap_to_btc` → sends BTC to user's configured `btcAddress`
  5. `bobGatewayActionProvider.get_orders` to confirm completion
  6. Adjust principal basis (remove cashed-out profit portion)
- All steps logged to transaction logger

### 6. Transaction Logger (`tx-logger.ts`)

Every action produces a log entry:

```typescript
interface TransactionEntry {
  timestamp: string;       // ISO 8601
  type: "deposit" | "withdraw" | "swap" | "claim_reward" | "rebalance" | "cash_out_btc" | "funding_received";
  tokenIn: string;         // e.g. "USDC"
  tokenOut?: string;       // e.g. "wBTC" (for swaps)
  amountIn: string;        // human-readable amount
  amountOut?: string;
  usdValueAtTime: number;  // USD value at time of transaction
  txHash: string;          // on-chain tx hash
  protocol?: string;       // e.g. "morpho", "compound"
  vault?: string;          // vault address if applicable
  notes?: string;          // LLM-generated context
}
```

- Persisted to `data/transactions.json` (append-only)
- Export methods: `exportCSV()`, `exportJSON()`
- Includes all fields needed for tax software import (Koinly, CoinTracker format)

### 7. Scheduler (`index.ts`)

- Long-running Node.js process
- On startup: wallet setup → display address → wait for config (BTC address)
- `setInterval` at `rebalanceIntervalHours` (default 6h)
- Each tick runs the full cycle: check funding → normalize → check yields → rebalance → check profit → cash out → log
- Graceful shutdown: saves state, completes in-progress transactions

## Agentkit Action Providers Used

| Provider | Actions Used | Purpose |
|----------|-------------|---------|
| `walletActionProvider` | `get_wallet_details` | Show agent's address, check ETH balance |
| `erc20ActionProvider` | `get_balance`, `approve` | Check token balances, approve vault deposits |
| `wethActionProvider` | `wrap_eth` | Wrap raw ETH if received |
| `vaultsfyiActionProvider` | `vaults`, `positions`, `execute_step`, `transaction_context`, `claim_rewards`, `benchmark_apy`, `rewards_context`, `detailed_vault`, `vault_historical_data` | Yield farming core |
| `cdpEvmWalletActionProvider` | `swap`, `get_swap_price` | Asset normalization, USDC↔wBTC swaps |
| `bobGatewayActionProvider` | `swap_to_btc`, `get_orders` | BTC profit cash-out |
| `pythActionProvider` | `fetch_price` | BTC/USDC prices for cost basis + profit calc |

## LLM (Claude) Decision Points

The agent calls Claude at these points (not on every cycle — only when decisions are needed):

1. **Vault selection** — "Given these vaults on Base with these APYs and TVLs, how should I allocate $X? Consider risk diversification."
2. **Rebalance evaluation** — "Current vault yields vs. available alternatives. Is the improvement worth the gas cost?"
3. **Error recovery** — "Transaction failed with this error. Should I retry, wait, or try an alternative?"
4. **Status reports** — "Summarize current portfolio, yields earned, actions taken since last report."

## Tech Stack

- **TypeScript** + Node.js (ES modules)
- **`@coinbase/agentkit`** — imported from local `/Users/nud3l/code/agentkit/typescript/agentkit` (no modifications)
- **`@coinbase/agentkit-langchain`** — from local `/Users/nud3l/code/agentkit/typescript/framework-extensions/langchain`
- **`@langchain/langgraph`** — agent orchestration + state persistence (checkpointing)
- **`@langchain/anthropic`** — Claude as the LLM
- **CDP SDK** — wallet management (via agentkit's `CdpEvmWalletProvider`)

## Configuration (`config.json`)

```json
{
  "btcAddress": "bc1q...",
  "usdcSplitPercent": 70,
  "profitThresholdUsd": 500,
  "rebalanceIntervalHours": 6,
  "minSwapAmountUsd": 25,
  "maxVaultAllocationPercent": 50,
  "minVaultTvlUsd": 100000
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `btcAddress` | string | User's BTC address for profit cash-outs |
| `usdcSplitPercent` | number (0-100) | % of incoming wBTC to swap to USDC. Rest stays as wBTC for BTC-denominated vaults |
| `profitThresholdUsd` | number | USD profit threshold that triggers BTC cash-out |
| `rebalanceIntervalHours` | number | How often the agent checks yields and rebalances (default 6) |
| `minSwapAmountUsd` | number | Minimum swap size to avoid gas eating into small amounts |
| `maxVaultAllocationPercent` | number (0-100) | Max % of portfolio in any single vault |
| `minVaultTvlUsd` | number | Minimum vault TVL to consider (risk filter) |

## Environment Variables

```
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_WALLET_SECRET=...
ANTHROPIC_API_KEY=...
```

## State Persistence

LangGraph checkpointing handles agent state across restarts:

- Current wallet balances (last known)
- Principal basis per asset
- Active vault positions
- Cumulative profit taken
- Last rebalance timestamp
- Transaction log pointer

Checkpoint store: local SQLite file (`data/agent-state.db`) via `@langchain/langgraph-checkpoint-sqlite`.

## Risk Considerations

- **Smart contract risk:** Vaults could be exploited. `minVaultTvlUsd` and `maxVaultAllocationPercent` provide some mitigation through filtering and diversification.
- **Slippage:** BOB Gateway and CDP swaps have slippage. Agent should check `get_swap_price` before executing and abort if slippage exceeds a threshold.
- **Gas costs:** On Base, gas is low (~$0.01-0.10 per tx). `minSwapAmountUsd` prevents uneconomical tiny swaps.
- **BOB Gateway reliability:** swap_to_btc depends on the BOB Gateway API. Agent should handle failures gracefully and retry on next cycle.
- **Key security:** CDP wallet credentials stored as environment variables. The agent never has access to BTC private keys.
