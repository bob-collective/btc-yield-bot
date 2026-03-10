import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all heavy dependencies
vi.mock("@coinbase/agentkit", () => ({
  AgentKit: {
    from: vi.fn().mockResolvedValue({ mockAgentKit: true }),
  },
  EvmWalletProvider: class {},
  walletActionProvider: vi.fn(() => "walletAction"),
  erc20ActionProvider: vi.fn(() => "erc20Action"),
  wethActionProvider: vi.fn(() => "wethAction"),
  pythActionProvider: vi.fn(() => "pythAction"),
  vaultsfyiActionProvider: vi.fn(() => "vaultsfyiAction"),
  bobGatewayActionProvider: vi.fn(() => "bobGatewayAction"),
  ensoActionProvider: vi.fn(() => "ensoAction"),
}));

vi.mock("@coinbase/agentkit-langchain", () => ({
  getLangChainTools: vi.fn().mockResolvedValue(["tool1", "tool2"]),
}));

vi.mock("@langchain/langgraph", () => ({
  MemorySaver: vi.fn(),
}));

const mockStream = {
  async *[Symbol.asyncIterator]() {
    yield { agent: { messages: [{ content: "agent response" }] } };
    yield { tools: { messages: [{ content: "tool output here" }] } };
  },
};

vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: vi.fn().mockReturnValue({
    stream: vi.fn().mockResolvedValue(mockStream),
  }),
}));

vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: vi.fn(),
}));

vi.mock("@langchain/core/messages", () => ({
  HumanMessage: class {
    content: string;
    constructor(msg: string) {
      this.content = msg;
    }
  },
}));

vi.mock("../config", () => ({
  getEnv: () => ({ ANTHROPIC_API_KEY: "sk-test" }),
}));

vi.mock("../notify", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../prompts", () => ({
  vaultSelectionPrompt: () => "vault prompt",
  rebalanceDecisionPrompt: () => "rebalance prompt",
}));

describe("agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createAgents", () => {
    it("initializes AgentKit with all action providers", async () => {
      const { createAgents } = await import("../agent");
      const { AgentKit } = await import("@coinbase/agentkit");
      const mockWallet = {
        getAddress: () => "0xWallet",
        getNetwork: () => ({ networkId: "base-mainnet" }),
      } as any;

      await createAgents(mockWallet, {
        btcCashOutAddress: "bc1qtest",
      } as any);

      expect(AgentKit.from).toHaveBeenCalledWith(
        expect.objectContaining({
          walletProvider: mockWallet,
          actionProviders: expect.arrayContaining([
            "walletAction",
            "erc20Action",
            "wethAction",
            "pythAction",
            "vaultsfyiAction",
            "bobGatewayAction",
            "ensoAction",
          ]),
        })
      );
    });

    it("creates two ChatAnthropic instances for light and heavy models", async () => {
      const { createAgents } = await import("../agent");
      const { ChatAnthropic } = await import("@langchain/anthropic");
      const mockWallet = {
        getAddress: () => "0xWallet",
        getNetwork: () => ({ networkId: "base-mainnet" }),
      } as any;

      await createAgents(mockWallet, {
        btcCashOutAddress: "bc1qtest",
      } as any);

      expect(ChatAnthropic).toHaveBeenCalledTimes(2);
      expect(ChatAnthropic).toHaveBeenCalledWith(
        expect.objectContaining({ model: "claude-haiku-4-5-20251001" })
      );
      expect(ChatAnthropic).toHaveBeenCalledWith(
        expect.objectContaining({ model: "claude-sonnet-4-6" })
      );
    });

  });

  describe("runAgentTask", () => {
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
  });
});
