import {
  AgentKit,
  EvmWalletProvider,
  walletActionProvider,
  erc20ActionProvider,
  wethActionProvider,
  pythActionProvider,
  vaultsfyiActionProvider,
  bobGatewayActionProvider,
  ensoActionProvider,
} from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { AgentConfig, getEnv } from "./config";
import { createLogger } from "./notify";
import { vaultSelectionPrompt, rebalanceDecisionPrompt } from "./prompts";

const log = createLogger("Agent");

export async function createAgents(
  walletProvider: EvmWalletProvider,
  config: AgentConfig
) {
  const env = getEnv();

  const agentkit = await AgentKit.from({
    walletProvider,
    actionProviders: [
      walletActionProvider(),
      erc20ActionProvider(),
      wethActionProvider(),
      pythActionProvider(),
      vaultsfyiActionProvider(),
      bobGatewayActionProvider(),
      ensoActionProvider(),
    ],
  });

  const tools = await getLangChainTools(agentkit);

  const systemPrompt = `You are btc-yield-agent, an autonomous yield farming agent on Base.

Your wallet address is ${walletProvider.getAddress()} on ${walletProvider.getNetwork().networkId}.
The user's BTC cash-out address is: ${config.btcCashOutAddress}

${vaultSelectionPrompt(config)}

${rebalanceDecisionPrompt(config)}

When executing swaps to BTC for cash-out, use swap_to_btc with the user's BTC address.
IMPORTANT: BOB Gateway offramp transactions require a small amount of native ETH for the bridge fee
(typically ~0.0005 ETH). Before calling swap_to_btc, check your ETH balance. If it is insufficient,
use the Enso route tool to swap ~$1 worth of USDC to ETH (tokenOut: 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE).
Always log what you're doing and why.`;

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

  const lightAgent = createReactAgent({
    llm: lightLlm,
    tools: tools as any,
    checkpointSaver: new MemorySaver(),
    prompt: systemPrompt,
  });

  const heavyAgent = createReactAgent({
    llm: heavyLlm,
    tools: tools as any,
    checkpointSaver: new MemorySaver(),
    prompt: systemPrompt,
  });

  const lightThreadConfig = {
    configurable: { thread_id: "btc-yield-agent-light" },
  };

  const heavyThreadConfig = {
    configurable: { thread_id: "btc-yield-agent-heavy" },
  };

  return { lightAgent, heavyAgent, lightThreadConfig, heavyThreadConfig, agentkit };
}

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
