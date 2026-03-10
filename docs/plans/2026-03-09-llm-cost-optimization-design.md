# LLM Cost Optimization Design

**Date:** 2026-03-09
**Status:** Approved

## Problem

The agent uses LangChain's `MemorySaver` with static thread IDs (`btc-yield-agent-light`, `btc-yield-agent-heavy`). Conversation history accumulates across cycles, causing input tokens to grow linearly. After ~17 cycles (~4 days), the heavy thread approaches the 200K context limit. Average monthly LLM cost ranges from $120-240 depending on restart frequency.

Additionally:
- No prompt caching — system prompt + tool definitions (~4-5K tokens) sent at full price on every LLM turn
- No `maxTokens` — responses can be arbitrarily long
- No token usage visibility — costs are invisible

## Goal

Make per-cycle LLM cost constant (~$0.42/cycle) while preserving intra-cycle memory (steps 3→4→6b share context within a single cycle). Target monthly cost: ~$35-50.

## Design Decisions

### Decision 1: Stateless across cycles, stateful within

Cross-cycle LLM memory provides no value because:
- Vault withdrawal types are persisted by `ProtocolRegistry` (disk)
- Positions and balances are queried fresh each cycle via tools
- Prior rebalance decisions are irrelevant — APY rankings change
- Failed transactions are edge cases handled within a cycle

Intra-cycle memory is valuable: step 4 (rebalance) benefits from seeing step 3 (deploy) results on the same heavy thread.

### Decision 2: Prompt caching over tool filtering

Tool filtering (per-step tool sets) was considered but rejected:
- Marginal savings (~$5-10/month) don't justify the maintenance burden
- Risk of missing a tool a step needs causes hard-to-debug failures
- Prompt caching achieves most of the savings with zero behavioral change

## Changes

### 1. Fresh Thread IDs Per Cycle

Generate unique thread IDs at the start of each cycle inside `runCycle`:

```typescript
const cycleId = Date.now().toString();
const lightThread = { configurable: { thread_id: `light-${cycleId}` } };
const heavyThread = { configurable: { thread_id: `heavy-${cycleId}` } };
```

Interface changes:
- `CycleAgents` drops `lightThreadConfig` / `heavyThreadConfig` — holds only the two agents
- `index.ts` stops creating/passing thread configs
- `runCycleWithNotify` and `runCycle` generate them internally
- Telegram's `runAgentTask` callback gets its own fresh thread each invocation

`MemorySaver` stays — provides intra-cycle memory. Old cycle checkpoints accumulate in memory but are small and only live until process restart.

### 2. Prompt Caching

Enable Anthropic prompt caching on both `ChatAnthropic` instances:

```typescript
const heavyLlm = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  clientOptions: {
    defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" }
  }
});
```

How it works:
- Anthropic caches the longest prefix of identical content across requests
- System prompt + tool definitions are identical across all calls
- First call per 5-min TTL window: full price + small write fee; subsequent calls: 90% discount on cached prefix
- Within a cycle, steps fire in sequence (well within 5 min), so later steps hit warm cache
- Across cycles (6h apart), cache is cold — first call pays full; acceptable

Savings: ~$0.06 per heavy task, ~$0.12/cycle on cached tokens alone.

Note: Verify exact `@langchain/anthropic` 1.3.x API during implementation — the beta header is the standard pattern but the library may expose a first-class option.

### 3. Max Tokens

Set output limits per agent type:

```typescript
const lightLlm = new ChatAnthropic({
  model: "claude-haiku-4-5-20251001",
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  maxTokens: 1024,
});

const heavyLlm = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  maxTokens: 4096,
});
```

Rationale:
- Light (1024): Balance checks and reward claims produce short outputs
- Heavy (4096): Generous room for vault reasoning + multi-step tx execution; ~3000 words, far more than any step needs
- If truncation occurs, usage logs (section 4) will reveal it; limits can be adjusted

### 4. Token Usage Logging

Capture usage metadata from each `runAgentTask` call:

- Extract `input_tokens`, `cache_read_input_tokens`, `output_tokens` from stream metadata
- Log per-task: token counts + estimated cost
- Log per-cycle: totals across all steps

```
[Agent] Step deploy_funds: 18,200 input (14,100 cached) + 1,340 output ≈ $0.017
[Agent] Cycle total: 52,400 input + 4,120 output ≈ $0.068
```

Cost estimation uses hardcoded rates:
- Haiku 4.5: $1/$5 per MTok (input/output), $0.10 cached
- Sonnet 4.6: $3/$15 per MTok (input/output), $0.30 cached

No persistent cost tracking or alerting — logs are sufficient for operational visibility.

Changes: ~20 lines in `runAgentTask` (agent.ts) to extract usage from stream, plus a small cost-estimate helper.

## Files Modified

| File | Change |
|------|--------|
| `src/agent.ts` | Add prompt caching headers, maxTokens, usage extraction in `runAgentTask` |
| `src/cycle.ts` | Generate per-cycle thread IDs, remove thread configs from `CycleAgents`, log cycle totals |
| `src/index.ts` | Stop creating/passing thread configs, simplify `CycleAgents` construction |

## Cost Projection

| Scenario | Before | After |
|----------|--------|-------|
| Per cycle (fresh) | $0.42 | $0.35 |
| Per cycle (accumulated, day 3) | $3.10 | $0.35 (constant) |
| Monthly (120 cycles) | $120-240 | ~$40-50 |
| Monthly total (+ gas + hosting) | $150-275 | ~$65-85 |

## Break-Even With Optimized Costs

| APY | Minimum Portfolio |
|-----|-------------------|
| 5%  | ~$13,000-17,000   |
| 10% | ~$6,500-8,500     |
