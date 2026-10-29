import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, type DefinedAgent } from "eve";
import { type CompactionStrategy, turns } from "eve/compaction";
import { mockModel } from "eve/evals";

/** Added to eve's summary prompt by the strategy, so the mock knows it's writing the summary. */
const SUMMARY_INSTRUCTIONS = "Keep Alice's project code word exactly as written.";
/** The strategy's own line in its checkpoint, which only a custom strategy writes. */
const STRATEGY_NOTE = "Kept by keepLatestTurn.";

/** Summarizes every turn but the latest, which it keeps word for word. */
const keepLatestTurn: CompactionStrategy = async (history, ctx) => {
  const all = turns(history);
  const summary = await ctx.summarize(all.slice(0, -1).flat(), {
    instructions: SUMMARY_INSTRUCTIONS,
  });
  return [...ctx.checkpoint(`${summary} ${STRATEGY_NOTE}`), ...(all.at(-1) ?? [])];
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

const agent: DefinedAgent = defineAgent({
  ...e2eAgentConfig(),
  model,
  modelContextWindowTokens: 100_000,
  compaction: { threshold: 0.2, compact: keepLatestTurn },
});

export default agent;
