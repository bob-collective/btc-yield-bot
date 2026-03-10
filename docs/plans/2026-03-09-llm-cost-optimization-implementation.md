# LLM Cost Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make per-cycle LLM cost constant by resetting thread state between cycles, enabling prompt caching, setting max tokens, and adding token usage logging.

**Architecture:** Four changes to three files. Fresh thread IDs per cycle (cycle.ts), prompt caching + maxTokens on ChatAnthropic (agent.ts), token usage extraction from stream (agent.ts), and simplified CycleAgents interface (cycle.ts + index.ts).

**Tech Stack:** @langchain/anthropic ^1.3.0, @langchain/langgraph ^1.2.0, vitest

---

### Task 1: Update `runAgentTask` to return token usage

**Files:**
- Modify: `src/agent.ts:94-120`
- Test: `src/__tests__/agent.test.ts`

**Step 1: Write the failing test**

Add to `src/__tests__/agent.test.ts` inside the `runAgentTask` describe block:

```typescript
it("extracts token usage from stream metadata", async () => {
  // Create a stream that includes usage_metadata on agent messages
  const streamWithUsage = {
    async *[Symbol.asyncIterator]() {
      yield {
        agent: {
          messages: [{
            content: "done",
            usage_metadata: {
              input_tokens: 1500,
              output_tokens: 300,
              input_token_details: { cache_read: 1000 },
            },
          }],
        },
      };
    },
  };

  const { createAgents, runAgentTask } = await import("../agent");
  const { createReactAgent } = await import("@langchain/langgraph/prebuilt");
  (createReactAgent as any).mockReturnValue({
    stream: vi.fn().mockResolvedValue(streamWithUsage),
  });

  const mockWallet = {
    getAddress: () => "0xWallet",
    getNetwork: () => ({ networkId: "base-mainnet" }),
  } as any;

  const { lightAgent, lightThreadConfig } = await createAgents(mockWallet, {
    btcCashOutAddress: "bc1qtest",
  } as any);

  const result = await runAgentTask(lightAgent, lightThreadConfig, "check balances");
  expect(result.output).toBe("done");
  expect(result.usage.inputTokens).toBe(1500);
  expect(result.usage.outputTokens).toBe(300);
  expect(result.usage.cacheReadTokens).toBe(1000);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/agent.test.ts -t "extracts token usage"`
Expected: FAIL — `runAgentTask` returns a string, not an object with `.output`

**Step 3: Update the existing test for new return type**

The existing test `"streams agent output and returns last response"` expects `result` to be a string. Update it:

```typescript
it("streams agent output and returns last response", async () => {
  const { createAgents, runAgentTask } = await import("../agent");
  const mockWallet = {
    getAddress: () => "0xWallet",
    getNetwork: () => ({ networkId: "base-mainnet" }),
  } as any;

  const { lightAgent, lightThreadConfig } = await createAgents(mockWallet, {
    btcCashOutAddress: "bc1qtest",
  } as any);

  const result = await runAgentTask(lightAgent, lightThreadConfig, "check balances");
  expect(result.output).toBe("agent response");
  expect(result.usage.inputTokens).toBe(0);
  expect(result.usage.outputTokens).toBe(0);
});
```

**Step 4: Implement the change in `src/agent.ts`**

Add the usage type and cost helper above `runAgentTask`:

```typescript
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentTaskResult {
  output: string;
  usage: TokenUsage;
}

const COST_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.10 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30 },
};

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const rates = COST_PER_MTOK[model];
  if (!rates) return 0;
  const uncachedInput = usage.inputTokens - usage.cacheReadTokens;
  return (
    (uncachedInput * rates.input) / 1_000_000 +
    (usage.cacheReadTokens * rates.cacheRead) / 1_000_000 +
    (usage.outputTokens * rates.output) / 1_000_000
  );
}
```

Then change `runAgentTask` signature and body:

```typescript
export async function runAgentTask(
  agent: ReturnType<typeof createReactAgent>,
  threadConfig: { configurable: { thread_id: string } },
  taskMessage: string
): Promise<AgentTaskResult> {
  const stream = await agent.stream(
    { messages: [new HumanMessage(taskMessage)] },
    threadConfig
  );

  let lastOutput = "";
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for await (const chunk of stream) {
    if ("agent" in chunk) {
      const msg = chunk.agent.messages[0];
      const content = msg.content;
      if (typeof content === "string") {
        lastOutput = content;
        log.info(content);
      }
      // Accumulate token usage from agent messages
      if (msg.usage_metadata) {
        usage.inputTokens += msg.usage_metadata.input_tokens ?? 0;
        usage.outputTokens += msg.usage_metadata.output_tokens ?? 0;
        usage.cacheReadTokens += msg.usage_metadata.input_token_details?.cache_read ?? 0;
        usage.cacheWriteTokens += msg.usage_metadata.input_token_details?.cache_creation ?? 0;
      }
    } else if ("tools" in chunk) {
      const content = chunk.tools.messages[0].content;
      if (typeof content === "string") {
        log.debug(content.substring(0, 200));
      }
    }
  }

  return { output: lastOutput, usage };
}
```

**Step 5: Run tests to verify both pass**

Run: `pnpm exec vitest run src/__tests__/agent.test.ts`
Expected: PASS (both tests)

**Step 6: Commit**

```bash
git add src/agent.ts src/__tests__/agent.test.ts
git commit -m "feat: return token usage from runAgentTask"
```

---

### Task 2: Update all `runAgentTask` callers to use new return type

**Files:**
- Modify: `src/cycle.ts:101-237` (6 call sites)
- Modify: `src/index.ts:74-86` (Telegram callbacks)

**Step 1: Update `cycle.ts` — change all `runAgentTask` calls**

Each call currently uses the string return directly. Change to destructure `.output`:

- Line 105: `const balanceOutput = (await runAgentTask(...)).output;`
- Line 149: `const step3Output = (await runAgentTask(...)).output;`
- Line 175: `const step4Output = (await runAgentTask(...)).output;`
- Line 191: `const step5Output = (await runAgentTask(...)).output;`
- Line 223: `const step6Output = (await runAgentTask(...)).output;`

Import `estimateCostUsd` and `type TokenUsage` from `./agent`.

Add usage accumulation and a cycle summary log at the end of `runCycle`:

```typescript
// At top of runCycle, after destructuring agents:
const cycleUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

// Helper to accumulate:
function addUsage(result: AgentTaskResult) {
  cycleUsage.inputTokens += result.usage.inputTokens;
  cycleUsage.outputTokens += result.usage.outputTokens;
  cycleUsage.cacheReadTokens += result.usage.cacheReadTokens;
  cycleUsage.cacheWriteTokens += result.usage.cacheWriteTokens;
}
```

Each step becomes:

```typescript
const step1Result = await runAgentTask(lightAgent, lightThread, `...`);
addUsage(step1Result);
const balanceOutput = step1Result.output;
```

At end of `runCycle`, log the cycle total:

```typescript
log.info(
  `Cycle tokens: ${cycleUsage.inputTokens} input (${cycleUsage.cacheReadTokens} cached) + ${cycleUsage.outputTokens} output`
);
```

**Step 2: Update `index.ts` Telegram callbacks**

Line 74-75: `runAgentTask` callback returns `AgentTaskResult` — callers expect `string`. Change to:

```typescript
runAgentTask: async (prompt: string) => {
  const result = await runAgentTask(heavyAgent, heavyThreadConfig, prompt);
  return result.output;
},
```

Line 81: Same pattern for `triggerCashOut`:

```typescript
const result = await runAgentTask(heavyAgent, heavyThreadConfig, `...`);
const output = result.output;
processCapturedTxs(walletProvider.drainTxs(), txLogger, output);
```

**Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/cycle.ts src/index.ts
git commit -m "refactor: update callers to use AgentTaskResult"
```

---

### Task 3: Add prompt caching and maxTokens to ChatAnthropic

**Files:**
- Modify: `src/agent.ts:59-67`
- Test: `src/__tests__/agent.test.ts`

**Step 1: Write the failing test**

Add to the `createAgents` describe block in `src/__tests__/agent.test.ts`:

```typescript
it("configures prompt caching and maxTokens on both models", async () => {
  const { createAgents } = await import("../agent");
  const { ChatAnthropic } = await import("@langchain/anthropic");
  const mockWallet = {
    getAddress: () => "0xWallet",
    getNetwork: () => ({ networkId: "base-mainnet" }),
  } as any;

  await createAgents(mockWallet, { btcCashOutAddress: "bc1qtest" } as any);

  // Light model: maxTokens 1024
  expect(ChatAnthropic).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1024,
      clientOptions: expect.objectContaining({
        defaultHeaders: expect.objectContaining({
          "anthropic-beta": "prompt-caching-2024-07-31",
        }),
      }),
    })
  );

  // Heavy model: maxTokens 4096
  expect(ChatAnthropic).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      clientOptions: expect.objectContaining({
        defaultHeaders: expect.objectContaining({
          "anthropic-beta": "prompt-caching-2024-07-31",
        }),
      }),
    })
  );
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/agent.test.ts -t "configures prompt caching"`
Expected: FAIL — current config lacks maxTokens and clientOptions

**Step 3: Implement the change in `src/agent.ts`**

Replace lines 59-67:

```typescript
const promptCachingOptions = {
  clientOptions: {
    defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
  },
};

const lightLlm = new ChatAnthropic({
  model: "claude-haiku-4-5-20251001",
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  maxTokens: 1024,
  ...promptCachingOptions,
});

const heavyLlm = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  maxTokens: 4096,
  ...promptCachingOptions,
});
```

**Step 4: Run tests to verify pass**

Run: `pnpm exec vitest run src/__tests__/agent.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/agent.ts src/__tests__/agent.test.ts
git commit -m "feat: enable prompt caching and set maxTokens"
```

---

### Task 4: Fresh thread IDs per cycle and simplify CycleAgents

**Files:**
- Modify: `src/cycle.ts:12-17, 92-101`
- Modify: `src/agent.ts:83-91`
- Modify: `src/index.ts:64-65, 74-75, 81`
- Test: `src/__tests__/agent.test.ts`

**Step 1: Write the failing test**

Add to `src/__tests__/agent.test.ts` in the `createAgents` describe block:

```typescript
it("no longer returns thread configs", async () => {
  const { createAgents } = await import("../agent");
  const mockWallet = {
    getAddress: () => "0xWallet",
    getNetwork: () => ({ networkId: "base-mainnet" }),
  } as any;

  const result = await createAgents(mockWallet, { btcCashOutAddress: "bc1qtest" } as any);
  expect(result).not.toHaveProperty("lightThreadConfig");
  expect(result).not.toHaveProperty("heavyThreadConfig");
  expect(result).toHaveProperty("lightAgent");
  expect(result).toHaveProperty("heavyAgent");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/__tests__/agent.test.ts -t "no longer returns thread configs"`
Expected: FAIL — `createAgents` still returns thread configs

**Step 3: Update `src/agent.ts` — remove thread configs from return**

Remove lines 83-89 (thread config declarations) and change line 91:

```typescript
return { lightAgent, heavyAgent, agentkit };
```

**Step 4: Update `src/cycle.ts` — simplify CycleAgents and generate fresh threads**

Replace `CycleAgents` interface (lines 12-17):

```typescript
export interface CycleAgents {
  lightAgent: any;
  heavyAgent: any;
}
```

In `runCycle` (line 92+), replace destructuring and add thread generation:

```typescript
async function runCycle(
  agents: CycleAgents,
  config: AgentConfig,
  txLogger: TxLogger,
  profitTracker: ProfitTracker,
  protocolRegistry: ProtocolRegistry,
  walletProvider: InstrumentedWalletProvider,
  vaultsfyiApiKey?: string,
) {
  const { lightAgent, heavyAgent } = agents;
  const cycleId = Date.now().toString();
  const lightThread = { configurable: { thread_id: `light-${cycleId}` } };
  const heavyThread = { configurable: { thread_id: `heavy-${cycleId}` } };
```

Update all `runAgentTask` calls in `runCycle` to use `lightThread`/`heavyThread` instead of `lightThreadConfig`/`heavyThreadConfig`.

**Step 5: Update `src/index.ts` — remove thread configs from agent creation**

Line 64: Change to:

```typescript
const { lightAgent, heavyAgent } = await createAgents(walletProvider, config);
const agents: CycleAgents = { lightAgent, heavyAgent };
```

Lines 74-75 (Telegram `runAgentTask` callback) — generate a fresh thread per ad-hoc query:

```typescript
runAgentTask: async (prompt: string) => {
  const threadConfig = { configurable: { thread_id: `telegram-${Date.now()}` } };
  const result = await runAgentTask(heavyAgent, threadConfig, prompt);
  return result.output;
},
```

Lines 81 (Telegram `triggerCashOut`) — same pattern:

```typescript
triggerCashOut: async () => {
  const entries = txLogger.getAll();
  const principal = profitTracker.getRemainingPrincipal(entries);
  walletProvider.setContext("cash_out");
  const threadConfig = { configurable: { thread_id: `cashout-${Date.now()}` } };
  const result = await runAgentTask(heavyAgent, threadConfig,
    `Check ETH balance — if below 0.0005 ETH, swap ~$1 USDC to native ETH via the Enso route tool (tokenOut: 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE).
     Then use swap_to_btc to send remaining USDC to ${config.btcCashOutAddress}.
     Report the order ID and transaction hash.`
  );
  processCapturedTxs(walletProvider.drainTxs(), txLogger, result.output);
},
```

**Step 6: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/agent.ts src/cycle.ts src/index.ts src/__tests__/agent.test.ts
git commit -m "feat: fresh thread IDs per cycle, remove static thread configs"
```

---

### Task 5: Add cost estimate helper tests

**Files:**
- Test: `src/__tests__/agent.test.ts`

**Step 1: Write tests for `estimateCostUsd`**

Add a new describe block in `src/__tests__/agent.test.ts`:

```typescript
describe("estimateCostUsd", () => {
  it("calculates Sonnet cost with cache hits", async () => {
    const { estimateCostUsd } = await import("../agent");
    const usage = {
      inputTokens: 20000,
      outputTokens: 2000,
      cacheReadTokens: 15000,
      cacheWriteTokens: 0,
    };
    const cost = estimateCostUsd("claude-sonnet-4-6", usage);
    // uncached input: 5000 * $3/M = $0.015
    // cached input: 15000 * $0.30/M = $0.0045
    // output: 2000 * $15/M = $0.030
    // total = $0.0495
    expect(cost).toBeCloseTo(0.0495, 4);
  });

  it("calculates Haiku cost without caching", async () => {
    const { estimateCostUsd } = await import("../agent");
    const usage = {
      inputTokens: 10000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const cost = estimateCostUsd("claude-haiku-4-5-20251001", usage);
    // input: 10000 * $1/M = $0.01
    // output: 500 * $5/M = $0.0025
    // total = $0.0125
    expect(cost).toBeCloseTo(0.0125, 4);
  });

  it("returns 0 for unknown model", async () => {
    const { estimateCostUsd } = await import("../agent");
    const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(estimateCostUsd("unknown-model", usage)).toBe(0);
  });
});
```

**Step 2: Run tests**

Run: `pnpm exec vitest run src/__tests__/agent.test.ts -t "estimateCostUsd"`
Expected: PASS (implementation was added in Task 1)

**Step 3: Commit**

```bash
git add src/__tests__/agent.test.ts
git commit -m "test: add estimateCostUsd unit tests"
```

---

### Task 6: Final verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All ~130+ tests pass

**Step 2: Verify TypeScript compiles**

Run: `pnpm exec tsc --noEmit`
Expected: No errors

**Step 3: Verify no regressions in imports**

Check that `CycleAgents` is imported correctly in `index.ts`, and that `AgentTaskResult` / `estimateCostUsd` / `TokenUsage` are exported from `agent.ts`.

**Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: fix any remaining type issues from cost optimization"
```
