# Receipt-Based Transaction Processing

## Problem

The agent's transaction log relies on regex parsing of LLM output text to extract amounts, tokens, protocols, and USD values. This produces garbage data:
- Protocol names like `"the"` and `"before"` from naive regex matches
- A single parsed amount stamped on every tx in a batch
- Zero/wrong USD values
- Phantom vault positions that cause the agent to attempt pointless rebalances (e.g., redeeming from empty Euler vaults)

## Solution

Replace LLM text parsing with on-chain transaction receipt decoding. After each captured tx, fetch the receipt and decode ERC20 Transfer events to get exact amounts, tokens, and transfer direction.

## Design

### 1. Receipt-based tx enrichment (`src/modules/transactions.ts`)

**New `processCapturedTxs` signature:**
```typescript
async function processCapturedTxs(
  captured: CapturedTx[],
  txLogger: TxLogger,
  walletProvider: InstrumentedWalletProvider,
  walletAddress: string,
): Promise<void>
```

- `llmOutput` parameter removed
- `walletProvider` added (for `waitForTransactionReceipt`)
- `walletAddress` added (for transfer direction detection)
- Returns `Promise<void>` (now async)

**Per-transaction processing:**
0. Skip ERC20 approve/transfer calls via `isErc20ApprovOrTransfer(tx.data)` before fetching receipt (avoids wasted RPC call)
1. Call `walletProvider.waitForTransactionReceipt(tx.hash as \`0x${string}\`)` to get the receipt
2. Parse all `Transfer(address indexed from, address indexed to, uint256 value)` events from `receipt.logs`
3. **Filter out Circle Paymaster gas transfers:** Exclude USDC Transfer events where `to` is the Circle Paymaster address (`0x6C973eBe80dCD8660841D4356bf15c32460271C9`). Every ERC-4337 UserOp includes a USDC gas payment to the paymaster — these must not pollute the transaction data.
4. Find transfers involving our wallet:
   - Outgoing (wallet is `from`): deposit or swap-out
   - Incoming (wallet is `to`): withdraw or swap-in
5. For USDC transfers (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`): `amount / 1e6 = USD value`
6. For other tokens: log raw amount, USD value = 0
7. Native ETH transfers (Enso swap output, BOB Gateway bridge fee) produce no ERC20 events — these intentionally fall through to the zero-value fallback. ETH amounts are small (bridge fees) and don't affect position tracking.

**Fetch receipts in parallel:** Use `Promise.all(captured.map(...))` to avoid sequential RPC latency when multiple txs are captured in a single step.

**Deposit vs withdraw classification:**
- `deploy_funds` context → deposit
- `rebalance` context → determine from USDC transfer direction:
  - Net outgoing (wallet→contract) = deposit
  - Net incoming (contract→wallet) = withdraw
  - If a single tx has both incoming and outgoing USDC transfers, use net direction
- `claim_rewards` context → claim_reward
- `cash_out` context → cash_out_btc
- Keep existing `CONTEXT_TO_TYPE` mapping as baseline, override with transfer direction for rebalance

**Protocol name:**
- Do not parse from LLM text
- Store `undefined` — the vault address (`tx.to`) is the canonical identifier
- Protocol names are cosmetic and can be derived from vaults.fyi data if needed later

**Error handling:**
- If `waitForTransactionReceipt` fails, log a warning and create a minimal entry with hash + context type + zero values
- Never silently drop a transaction

### 2. Caller updates

**cycle.ts** (4 call sites: steps 3, 4, 5, 6b):
```typescript
// Before:
processCapturedTxs(walletProvider.drainTxs(), txLogger, step3Output);

// After:
await processCapturedTxs(walletProvider.drainTxs(), txLogger, walletProvider, walletProvider.getAddress());
```

**index.ts** (1 call site: Telegram cashout handler):
Same pattern — pass walletProvider and address instead of LLM output.

**Total: 5 call sites.**

### 3. Fix `getVaultHistory` to key on vault address (`src/modules/portfolio.ts`)

The current `getVaultHistory` filters entries with `&& e.protocol`, which will silently exclude all new transactions logged with `protocol: undefined`. Update to:
- Filter on `e.vault` instead of `e.protocol`
- Key the vault map on `entry.vault` (always present — it's `tx.to`)
- Use `entry.protocol ?? undefined` when constructing `VaultHistoryEntry` (never `entry.protocol!` which would throw for new entries)

**Display fallback in cycle.ts:** The portfolio summary at cycle.ts:140 uses `v.protocol` for display. Update to fall back to a truncated vault address when protocol is undefined:
```typescript
const label = v.protocol ?? `${v.vault.slice(0, 6)}...${v.vault.slice(-4)}`;
```

### 4. Config + prompt changes

**config.ts:**
- Change `maxVaultAllocationPercent` default from `50` to `100`

**prompts.ts (`vaultSelectionPrompt`):**
- If `maxVaultAllocationPercent` is 100, omit the allocation cap line
- If < 100, keep current wording

**cycle.ts step 3 prompt:**
- Same conditional: omit the "Never allocate more than X%" rule when X = 100

### 5. Clean existing transaction log

Fix `data/transactions.json` (~20 entries) with these precise rules:
- Replace `protocol: "the"` and `protocol: "before"` with removal of the protocol field (set to undefined/omit)
- Remove the last entry (tx `0x9ff0...`, March 15) — this is the no-op Euler redeem from an empty vault
- For the batch of 4 deposits on March 10 22:04 with `protocol: "the"`: these are real deposits but with wrong protocol. Remove protocol field; amounts and vault addresses are correct since they came from separate tx captures
- Keep all other entries as-is — they were logged before the regex parsing got bad

### 6. Dead code removal

Remove from `transactions.ts` (no longer called from production code):
- `parseAmountFromOutput`
- `parseProtocolFromOutput`
- `parseUsdValueFromOutput`

Remove corresponding tests if they only test these functions in isolation.

Keep `isErc20ApprovOrTransfer` — still used for filtering approve/transfer txs.

### 7. Type improvements

- Update `CapturedTx.hash` type from `string` to `` `0x${string}` `` (hashes are always hex-prefixed)
- Import USDC address constant from `funding-monitor.ts` (or extract to a shared constants location) rather than redefining it
- Import Circle Paymaster address from `circle-paymaster-wallet.ts`

## Files Changed

| File | Change |
|------|--------|
| `src/modules/transactions.ts` | Receipt-based processing, remove LLM parsers |
| `src/modules/portfolio.ts` | `getVaultHistory` filters on `vault` not `protocol` |
| `src/modules/instrumented-wallet.ts` | `CapturedTx.hash` type → `` `0x${string}` `` |
| `src/cycle.ts` | Update 4 call sites to new async signature, conditional allocation cap in step 3 prompt |
| `src/index.ts` | Update Telegram cashout handler call site |
| `src/config.ts` | `maxVaultAllocationPercent` default → 100 |
| `src/prompts.ts` | Conditional allocation cap wording |
| `data/transactions.json` | Fix garbage entries per rules in section 5 |
| `src/__tests__/transactions.test.ts` | Update tests for new signature, remove LLM parser tests |

## Not Changed

- `TransactionEntry` interface (schema stays the same)
- `TxLogger` class
- `getPortfolioValueUsd`
