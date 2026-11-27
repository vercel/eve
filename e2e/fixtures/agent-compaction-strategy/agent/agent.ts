import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, type DefinedAgent } from "eve";
import type { CompactionStrategy, StoredHistoryMessage } from "eve/experimental/compaction";
import { mockModel } from "eve/evals";

/** Added to eve's summary prompt by the strategy, so the mock knows it's writing the summary. */
const SUMMARY_INSTRUCTIONS = "Keep Alice's project code word exactly as written.";
/** The strategy's own line in its checkpoint, which only a custom strategy writes. */
const STRATEGY_NOTE = "Kept by keepLatestTurn.";

const CONTEXT_WINDOW_TOKENS = 100_000;

/** Summarizes every turn but the latest, which it keeps word for word, once a request passes 20% of the window. */
const keepLatestTurn: CompactionStrategy = async (history, ctx) => {
  if (!ctx.requested && !ctx.overflow && ctx.tokens <= 0.2 * CONTEXT_WINDOW_TOKENS) {
    return undefined;
  }
  const latest = history
    .map((message) => message.role === "user" && message.kind === "user")
    .lastIndexOf(true);
  const { text } = await ctx.call({
    messages: [
      ...history.slice(0, latest),
      {
        content: "Summarize the conversation above for the next model.",
        kind: "context.compaction",
        role: "user",
      },
    ],
    system: SUMMARY_INSTRUCTIONS,
  });
  const head: StoredHistoryMessage[] = [
    {
      content: "The conversation so far is summarized below.",
      kind: "context.compaction",
      role: "user",
    },
    { content: `${text} ${STRATEGY_NOTE}`, role: "assistant" },
  ];
  return [...head, ...history.slice(latest)];
};

const model = mockModel({
  modelId: "compaction-strategy-model",
  respond(request) {
    if (
      request.messages.some(
        (entry) => entry.role === "system" && entry.text.includes(SUMMARY_INSTRUCTIONS),
      )
    ) {
      return "Alice's project code word is ORCHID-42.";
    }
    const message = request.lastUserMessage ?? "";
    if (message.includes("verify")) {
      const checkpoint = request.messages.find(
        (entry) => entry.role === "assistant" && entry.text.includes(STRATEGY_NOTE),
      );
      return {
        text: checkpoint?.text.includes("ORCHID-42")
          ? "CUSTOM_COMPACTION_OK"
          : "CUSTOM_COMPACTION_MISSING",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return {
      text: "Noted.",
      usage: { inputTokens: message.includes("report high usage") ? 30_000 : 1, outputTokens: 1 },
    };
  },
});

const base = e2eAgentConfig();

const agent: DefinedAgent = defineAgent({
  ...base,
  model,
  modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
  experimental: {
    ...base.experimental,
    compaction: keepLatestTurn,
  },
});

export default agent;
