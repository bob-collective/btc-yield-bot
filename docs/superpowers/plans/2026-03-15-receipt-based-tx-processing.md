# Receipt-Based Transaction Processing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LLM text parsing in transaction processing with on-chain receipt decoding, fix the existing garbage tx log, and allow 100% single-vault allocation.

**Architecture:** `processCapturedTxs` becomes async. For each captured tx, it fetches the receipt via `waitForTransactionReceipt`, decodes ERC20 Transfer events to get exact amounts/tokens/direction, and filters out Circle Paymaster gas transfers. The `llmOutput` parameter is removed entirely.

**Tech Stack:** viem 2.38.3 (parseAbiItem, receipt logs), vitest 4.x

**Spec:** `docs/superpowers/specs/2026-03-15-receipt-based-tx-processing-design.md`

---

## Chunk 1: Core transaction processing rewrite

### Task 1: Update `CapturedTx.hash` type

**Files:**
- Modify: `src/modules/instrumented-wallet.ts:28`

- [ ] **Step 1: Change the type**

In `src/modules/instrumented-wallet.ts`, change the `CapturedTx` interface:

```typescript
// Before:
export interface CapturedTx {
  hash: string;
// After:
export interface CapturedTx {
  hash: `0x${string}`;
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: All 142 tests pass. The test file uses string literals like `"0xabc123"` which are compatible with the template literal type.

- [ ] **Step 3: Commit**

```bash
git add src/modules/instrumented-wallet.ts
git commit -m "refactor: type CapturedTx.hash as 0x-prefixed hex string"
```

---

### Task 2: Rewrite `processCapturedTxs` to use receipt decoding

**Files:**
- Modify: `src/modules/transactions.ts`

- [ ] **Step 1: Add imports and constants at the top of transactions.ts**

Add after the existing imports:

Merge the `InstrumentedWalletProvider` import with the existing `CapturedTx` import:

```typescript
// Before:
import type { CapturedTx } from "./instrumented-wallet";
// After:
import type { CapturedTx, InstrumentedWalletProvider } from "./instrumented-wallet";
```

Add after the existing imports:

```typescript
import { USDC_BASE_ADDRESS, CIRCLE_PAYMASTER_ADDRESS } from "./circle-paymaster-wallet";

const USDC_DECIMALS = 6;
```

- [ ] **Step 2: Write the new `processCapturedTxs` function**

Replace the existing `processCapturedTxs` function (lines 149-197) with:

```typescript
/**
 * Process captured txs by fetching on-chain receipts and decoding Transfer events.
 * Replaces the previous LLM-text-parsing approach with exact on-chain data.
 */
export async function processCapturedTxs(
  captured: CapturedTx[],
  txLogger: TxLogger,
  walletProvider: InstrumentedWalletProvider,
  walletAddress: string,
): Promise<void> {
  const wallet = walletAddress.toLowerCase();
  const paymaster = CIRCLE_PAYMASTER_ADDRESS.toLowerCase();
  const usdcAddress = USDC_BASE_ADDRESS.toLowerCase();

  // Fetch all receipts in parallel
  const receipts = await Promise.all(
    captured.map(async (tx) => {
      // Skip ERC20 approve/transfer calls before fetching receipt
      if (isErc20ApprovOrTransfer(tx.data)) {
        return { tx, receipt: null, skipped: true };
      }
      try {
        const receipt = await walletProvider.waitForTransactionReceipt(tx.hash);
        return { tx, receipt, skipped: false };
      } catch (err) {
        log.warn(`Failed to fetch receipt for ${tx.hash}: ${err}`);
        return { tx, receipt: null, skipped: false };
      }
    }),
  );

  for (const { tx, receipt, skipped } of receipts) {
    if (skipped) {
      log.info(`skipping tx ${tx.hash} (ERC20 approve/transfer)`);
      continue;
    }

    let type = mapContextToTxType(tx.context);
    let tokenIn = "unknown";
    let amountIn = "0";
    let usdValue = 0;

    if (receipt?.logs) {
      // Decode ERC20 Transfer events from receipt
      const transfers: Array<{
        token: string;
        from: string;
        to: string;
        amount: bigint;
      }> = [];

      for (const logEntry of receipt.logs) {
        try {
          // Transfer event topic: keccak256("Transfer(address,address,uint256)")
          if (
            logEntry.topics &&
            logEntry.topics.length >= 3 &&
            logEntry.topics[0] ===
              "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
          ) {
            const from = ("0x" + logEntry.topics[1].slice(26)).toLowerCase();
            const to = ("0x" + logEntry.topics[2].slice(26)).toLowerCase();
            const amount = BigInt(logEntry.data);
            transfers.push({
              token: (logEntry.address as string).toLowerCase(),
              from,
              to,
              amount,
            });
          }
        } catch {
          // Skip malformed log entries
        }
      }

      // Filter out Circle Paymaster gas payments
      const relevant = transfers.filter(
        (t) => !(t.token === usdcAddress && t.to === paymaster),
      );

      // Find USDC transfers involving our wallet
      const outgoing = relevant.filter(
        (t) => t.from === wallet && t.token === usdcAddress,
      );
      const incoming = relevant.filter(
        (t) => t.to === wallet && t.token === usdcAddress,
      );

      const outTotal = outgoing.reduce((s, t) => s + t.amount, 0n);
      const inTotal = incoming.reduce((s, t) => s + t.amount, 0n);

      if (outTotal > 0n || inTotal > 0n) {
        tokenIn = "USDC";
        // Use the larger direction for amount
        const netAmount = outTotal > inTotal ? outTotal : inTotal;
        const amountNum = Number(netAmount) / 10 ** USDC_DECIMALS;
        amountIn = amountNum.toFixed(6);
        usdValue = parseFloat(amountNum.toFixed(2));

        // For rebalance context, determine direction from net USDC flow
        if (tx.context === "rebalance") {
          type = inTotal > outTotal ? "withdraw" : "deposit";
        }
      } else {
        // Check for non-USDC transfers (cbBTC, etc.)
        const nonUsdcOut = relevant.filter((t) => t.from === wallet && t.token !== usdcAddress);
        const nonUsdcIn = relevant.filter((t) => t.to === wallet && t.token !== usdcAddress);
        const anyNonUsdc = nonUsdcOut.length > 0 ? nonUsdcOut[0] : nonUsdcIn.length > 0 ? nonUsdcIn[0] : null;
        if (anyNonUsdc) {
          tokenIn = anyNonUsdc.token;
          amountIn = anyNonUsdc.amount.toString();
          // USD value unknown for non-USDC tokens
        }
      }
    }

    txLogger.log({
      type,
      tokenIn,
      amountIn,
      usdValueAtTime: usdValue,
      txHash: tx.hash,
      protocol: undefined,
      vault: tx.to,
    });

    log.info(`processed tx ${tx.hash} as ${type}`);
  }
}
```

- [ ] **Step 3: Remove dead LLM parsing functions**

Delete these functions from `transactions.ts`:
- `parseAmountFromOutput` (lines 105-109)
- `parseProtocolFromOutput` (lines 112-115)
- `parseUsdValueFromOutput` (lines 118-121)

Also remove them from the module's exports (they're used via named imports in the test file).

- [ ] **Step 4: Do NOT commit yet** — the callers and tests still use the old signature. Continue to Task 3 and Task 4 before committing.

---

### Task 3: Rewrite transaction tests

**Files:**
- Modify: `src/__tests__/transactions.test.ts`

- [ ] **Step 1: Remove LLM parser test blocks**

Delete these `describe` blocks entirely from `transactions.test.ts`:
- `parseAmountFromOutput` (lines 102-148)
- `parseProtocolFromOutput` (lines 154-175)
- `parseUsdValueFromOutput` (lines 181-198)

Update the imports at lines 1-12 to remove deleted functions and keep CapturedTx:

```typescript
import {
  TxLogger,
  TransactionEntry,
  mapContextToTxType,
  processCapturedTxs,
  isErc20ApprovOrTransfer,
} from "../modules/transactions";
import type { CapturedTx } from "../modules/instrumented-wallet";
```

- [ ] **Step 2: Rewrite `processCapturedTxs` tests with mock wallet provider**

Replace the entire `describe("processCapturedTxs", ...)` block (lines 241-378) with:

```typescript
describe("processCapturedTxs", () => {
  // Transfer event topic for keccak256("Transfer(address,address,uint256)")
  const TRANSFER_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const WALLET = "0x65Bc733fc0bb4417A63dE6cc8f7f955985F95e96";
  const WALLET_PADDED = "0x00000000000000000000000065bc733fc0bb4417a63de6cc8f7f955985f95e96";
  const VAULT = "0xBEEFFFe68dFc2D3BD1ABdAd37c70634973b16478";
  const VAULT_PADDED = "0x000000000000000000000000beefffe68dfc2d3bd1abdad37c70634973b16478";
  const PAYMASTER = "0x6c973ebe80dcd8660841d4356bf15c32460271c9";
  const PAYMASTER_PADDED = "0x0000000000000000000000006c973ebe80dcd8660841d4356bf15c32460271c9";

  function makeMockLogger() {
    return {
      log: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
    } as unknown as TxLogger & { log: ReturnType<typeof vi.fn> };
  }

  function makeTransferLog(
    token: string,
    from: string,
    to: string,
    amount: bigint,
  ) {
    return {
      address: token,
      topics: [TRANSFER_TOPIC, from, to],
      data: "0x" + amount.toString(16).padStart(64, "0"),
    };
  }

  function makeMockWalletProvider(receipt: any) {
    return {
      waitForTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    } as any;
  }

  const baseTx: CapturedTx = {
    hash: "0xabc123" as `0x${string}`,
    to: VAULT,
    context: "deploy_funds",
    timestamp: "2026-03-07T00:00:00.000Z",
  };

  it("decodes USDC deposit from receipt Transfer events", async () => {
    const mockLogger = makeMockLogger();
    const receipt = {
      logs: [
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, VAULT_PADDED, 1000_000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);

    await processCapturedTxs([baseTx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "deposit",
        tokenIn: "USDC",
        amountIn: "1000.000000",
        usdValueAtTime: 1000,
        vault: VAULT,
        txHash: "0xabc123",
      }),
    );
  });

  it("decodes USDC withdraw from receipt Transfer events", async () => {
    const mockLogger = makeMockLogger();
    const receipt = {
      logs: [
        makeTransferLog(USDC_ADDRESS, VAULT_PADDED, WALLET_PADDED, 500_000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);
    const tx = { ...baseTx, context: "rebalance" };

    await processCapturedTxs([tx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "withdraw",
        tokenIn: "USDC",
        amountIn: "500.000000",
        usdValueAtTime: 500,
      }),
    );
  });

  it("filters out Circle Paymaster gas transfers", async () => {
    const mockLogger = makeMockLogger();
    const receipt = {
      logs: [
        // Real deposit: wallet -> vault
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, VAULT_PADDED, 100_000000n),
        // Gas payment: wallet -> paymaster (should be filtered)
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, PAYMASTER_PADDED, 50000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);

    await processCapturedTxs([baseTx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        amountIn: "100.000000",
        usdValueAtTime: 100,
      }),
    );
  });

  it("skips ERC20 approve txs without fetching receipt", async () => {
    const mockLogger = makeMockLogger();
    const wp = makeMockWalletProvider({});
    const approveTx: CapturedTx = {
      ...baseTx,
      data: "0x095ea7b3000000000000000000000000spender0000000000000000000000000000",
    };

    await processCapturedTxs([approveTx], mockLogger, wp, WALLET);

    expect(mockLogger.log).not.toHaveBeenCalled();
    expect(wp.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("falls back to zero values when receipt fetch fails", async () => {
    const mockLogger = makeMockLogger();
    const wp = {
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    } as any;

    await processCapturedTxs([baseTx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "deposit",
        tokenIn: "unknown",
        amountIn: "0",
        usdValueAtTime: 0,
        txHash: "0xabc123",
      }),
    );
  });

  it("handles native ETH txs with no Transfer events", async () => {
    const mockLogger = makeMockLogger();
    const receipt = { logs: [] };
    const wp = makeMockWalletProvider(receipt);
    const tx = { ...baseTx, context: "cash_out" };

    await processCapturedTxs([tx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cash_out_btc",
        tokenIn: "unknown",
        amountIn: "0",
      }),
    );
  });

  it("determines rebalance deposit from net outgoing USDC", async () => {
    const mockLogger = makeMockLogger();
    const receipt = {
      logs: [
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, VAULT_PADDED, 200_000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);
    const tx = { ...baseTx, context: "rebalance" };

    await processCapturedTxs([tx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ type: "deposit" }),
    );
  });

  it("does nothing for empty captured array", async () => {
    const mockLogger = makeMockLogger();
    const wp = makeMockWalletProvider({});

    await processCapturedTxs([], mockLogger, wp, WALLET);

    expect(mockLogger.log).not.toHaveBeenCalled();
  });

  it("logs non-USDC token transfers with raw amount", async () => {
    const mockLogger = makeMockLogger();
    const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
    const CBBTC_PADDED = "0x000000000000000000000000cbb7c0000ab88b473b1f5afd9ef808440eed33bf";
    const receipt = {
      logs: [
        makeTransferLog(CBBTC, WALLET_PADDED, VAULT_PADDED, 50000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);

    await processCapturedTxs([baseTx], mockLogger, wp, WALLET);

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenIn: CBBTC.toLowerCase(),
        amountIn: "50000000",
        usdValueAtTime: 0,
      }),
    );
  });

  it("uses net USDC direction for mixed incoming/outgoing rebalance", async () => {
    const mockLogger = makeMockLogger();
    const OTHER_VAULT = "0x1234567890abcdef1234567890abcdef12345678";
    const OTHER_VAULT_PADDED = "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678";
    const receipt = {
      logs: [
        // Incoming: vault sends 300 USDC back
        makeTransferLog(USDC_ADDRESS, OTHER_VAULT_PADDED, WALLET_PADDED, 300_000000n),
        // Outgoing: wallet sends 100 USDC to router
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, VAULT_PADDED, 100_000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);
    const tx = { ...baseTx, context: "rebalance" };

    await processCapturedTxs([tx], mockLogger, wp, WALLET);

    // Net incoming (300 - 100 = 200), so should be classified as withdraw
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "withdraw",
        amountIn: "300.000000",
      }),
    );
  });

  it("fetches receipts in parallel", async () => {
    const mockLogger = makeMockLogger();
    const receipt = {
      logs: [
        makeTransferLog(USDC_ADDRESS, WALLET_PADDED, VAULT_PADDED, 50_000000n),
      ],
    };
    const wp = makeMockWalletProvider(receipt);
    const txs = [baseTx, { ...baseTx, hash: "0xdef456" as `0x${string}` }];

    await processCapturedTxs(txs, mockLogger, wp, WALLET);

    expect(wp.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(mockLogger.log).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Do NOT commit yet** — continue to Task 4.

---

### Task 4: Update all `processCapturedTxs` call sites

**Files:**
- Modify: `src/cycle.ts:227,246,259,323`
- Modify: `src/index.ts:90`

- [ ] **Step 1: Update cycle.ts call sites**

In `src/cycle.ts`, update these 4 lines. Each currently reads:
```typescript
processCapturedTxs(walletProvider.drainTxs(), txLogger, stepNOutput);
```

Change each to:
```typescript
await processCapturedTxs(walletProvider.drainTxs(), txLogger, walletProvider, walletProvider.getAddress());
```

The 4 locations:
- Line 227: after step 3 (deploy_funds)
- Line 246: after step 4 (rebalance)
- Line 259: after step 5 (claim_rewards)
- Line 323: after step 6b (cash_out)

- [ ] **Step 2: Update index.ts Telegram cashout handler**

In `src/index.ts` line 90, change:
```typescript
processCapturedTxs(walletProvider.drainTxs(), txLogger, result.output);
```
to:
```typescript
await processCapturedTxs(walletProvider.drainTxs(), txLogger, walletProvider, walletProvider.getAddress());
```

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Commit Tasks 2+3+4 together** (avoids broken intermediate state)

```bash
git add src/modules/transactions.ts src/__tests__/transactions.test.ts src/cycle.ts src/index.ts
git commit -m "feat: replace LLM text parsing with on-chain receipt decoding in processCapturedTxs"
```

---

## Chunk 2: Portfolio, config, and data cleanup

### Task 5: Fix `getVaultHistory` to key on vault address

**Files:**
- Modify: `src/modules/portfolio.ts:139-178`
- Modify: `src/cycle.ts:139-141`

- [ ] **Step 1: Make `VaultHistoryEntry.protocol` optional and update `getVaultHistory`**

In `src/modules/portfolio.ts`, first change the `VaultHistoryEntry` interface (line 110):
```typescript
// Before:
  protocol: string;
// After:
  protocol?: string;
```

Then change the `getVaultHistory` method.

Change line 141:
```typescript
// Before:
const relevant = entries.filter(
  (e) => (e.type === "deposit" || e.type === "withdraw") && e.protocol,
);
// After:
const relevant = entries.filter(
  (e) => (e.type === "deposit" || e.type === "withdraw") && e.vault,
);
```

Change line 150:
```typescript
// Before:
const key = entry.vault ?? entry.protocol!;
// After:
const key = entry.vault!;
```

Change the map value construction (lines 162-163) to use optional protocol:
```typescript
// Before:
protocol: entry.protocol!,
// After:
protocol: entry.protocol ?? undefined,
```

- [ ] **Step 2: Update display fallback in cycle.ts**

In `src/cycle.ts`, change lines 139-141 where the portfolio summary is built:

```typescript
// Before:
const posLines = activeVaults.map(
  (v) => `- ${v.protocol}: ~$${(v.totalDeposited - v.totalWithdrawn).toFixed(2)} in vault ${v.vault}`,
).join("\n");
// After:
const posLines = activeVaults.map(
  (v) => {
    const label = v.protocol ?? `${v.vault.slice(0, 6)}...${v.vault.slice(-4)}`;
    return `- ${label}: ~$${(v.totalDeposited - v.totalWithdrawn).toFixed(2)} in vault ${v.vault}`;
  },
).join("\n");
```

Also update the portfolio summary display at line 157-159:
```typescript
// Before:
`  ${v.protocol} (${v.vault}): ~$${(v.totalDeposited - v.totalWithdrawn).toFixed(2)}`,
// After:
`  ${v.protocol ?? v.vault.slice(0, 10)} (${v.vault}): ~$${(v.totalDeposited - v.totalWithdrawn).toFixed(2)}`,
```

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: All tests pass. The portfolio tests use entries with `protocol` set, so existing tests still work. New entries with `protocol: undefined` but `vault` set will now be correctly included.

- [ ] **Step 4: Commit**

```bash
git add src/modules/portfolio.ts src/cycle.ts
git commit -m "fix: key vault history on vault address instead of protocol name"
```

---

### Task 6: Config and prompt changes for 100% allocation

**Files:**
- Modify: `src/config.ts:56`
- Modify: `src/prompts.ts:10-11`
- Modify: `src/cycle.ts:221-222`

- [ ] **Step 1: Change default in config.ts**

In `src/config.ts` line 56, change:
```typescript
// Before:
maxVaultAllocationPercent: z.number().min(1).max(100).default(50),
// After:
maxVaultAllocationPercent: z.number().min(1).max(100).default(100),
```

- [ ] **Step 2: Make allocation cap conditional in prompts.ts**

In `src/prompts.ts`, change lines 9-11:
```typescript
// Before:
ALLOCATION:
- Never allocate more than ${config.maxVaultAllocationPercent}% of total portfolio to a single vault.
- Only consider vaults with TVL above $${config.minVaultTvlUsd.toLocaleString()}.
// After:
ALLOCATION:
${config.maxVaultAllocationPercent < 100 ? `- Never allocate more than ${config.maxVaultAllocationPercent}% of total portfolio to a single vault.\n` : ''}- Only consider vaults with TVL above $${config.minVaultTvlUsd.toLocaleString()}.
```

- [ ] **Step 3: Make allocation cap conditional in cycle.ts step 3 prompt**

In `src/cycle.ts`, change line 221-222:
```typescript
// Before:
- Never allocate more than ${config.maxVaultAllocationPercent}% of portfolio to a single vault.
// After:
${config.maxVaultAllocationPercent < 100 ? `- Never allocate more than ${config.maxVaultAllocationPercent}% of portfolio to a single vault.\n` : ''}\
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: All tests pass. The prompts tests may need checking — verify they still pass with the conditional logic.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/prompts.ts src/cycle.ts
git commit -m "feat: allow 100% single-vault allocation, make cap conditional in prompts"
```

---

### Task 7: Clean existing transaction log

**Files:**
- Modify: `data/transactions.json`

- [ ] **Step 1: Fix garbage entries**

Apply these changes to `data/transactions.json`:

1. **Lines 133-142** (deposit to 0x3094, `protocol: "Euler"`): This entry has the wrong protocol — the vault `0x3094...` is Morpho, not Euler. Change `"protocol": "Euler"` to remove the protocol field.

2. **Lines 143-152** (deposit to 0x4C1a, `protocol: "Euler"`): Same issue — vault `0x4C1a...` is actually Euler, so this one is correct. Leave as-is.

3. **Lines 153-162** (deposit, `protocol: "the"`): Remove the `"protocol": "the"` field.

4. **Lines 163-172** (deposit, `protocol: "the"`): Remove the `"protocol": "the"` field.

5. **Lines 173-182** (deposit, `protocol: "the"`): Remove the `"protocol": "the"` field.

6. **Lines 183-192** (deposit, `protocol: "the"`): Remove the `"protocol": "the"` field.

7. **Lines 193-202** (withdraw, `protocol: "Morpho"`): OK, leave as-is.

8. **Lines 203-212** (withdraw, `protocol: "Morpho"`): OK, leave as-is.

9. **Lines 213-222** (withdraw, `protocol: "Morpho"`): OK, leave as-is.

10. **Lines 223-232** (withdraw, `protocol: "before"`): Remove `"protocol": "before"` field.

11. **Lines 233-242** (withdraw tx `0x9ff0...`, `protocol: "the"`): **Delete this entire entry** — it's the no-op Euler redeem from an empty vault on March 15.

- [ ] **Step 2: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('data/transactions.json','utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: All tests pass (tests don't read production data).

- [ ] **Step 4: Commit**

```bash
git add data/transactions.json
git commit -m "fix: clean garbage protocol names and remove no-op entries from tx log"
```

---

### Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the notify.ts description in Architecture**

In `CLAUDE.md`, the architecture section describes `transactions.ts`. Verify it's still accurate after the changes. Update if needed:
- `transactions.ts` description should mention receipt-based processing instead of LLM output parsing

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for receipt-based tx processing"
```
