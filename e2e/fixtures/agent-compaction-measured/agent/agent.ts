import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { CATALOG_HANDOFF_MARKER, CATALOG_HANDOFF_REQUEST } from "../constants";

const CHECKPOINT_MARKER = "Summary of our conversation so far:";
// The 52,000-character result fits beside the 2,048-token reserve,
// but exceeds the 20,000-token threshold beside this larger summary.
const CATALOG_HANDOFF_SUMMARY =
  "Alice and Bob are organizing the catalog review. The handoff notes are the next shared record. "
    .repeat(400)
    .slice(0, 32_000);

const model = mockModel({
  modelId: "measured-compaction-model",
  respond(request) {
    const catalogHandoff = request.userMessages.some((text) =>
      text.includes(CATALOG_HANDOFF_REQUEST),
    );
    if (
      request.messages.some(
        (entry) => entry.role === "system" && entry.text.includes("CONTEXT CHECKPOINT COMPACTION"),
      )
    ) {
      if (catalogHandoff) {
        const completed = request.messages.some((entry) =>
          entry.text
            .split("\n\n")
            .some(
              (section) =>
                section.startsWith("### tool\nTool record-catalog-handoff returned ") &&
                section.includes(CATALOG_HANDOFF_MARKER),
            ),
        );
        return completed
          ? `Alice's catalog handoff is complete: ${CATALOG_HANDOFF_MARKER}.`
          : CATALOG_HANDOFF_SUMMARY;
      }
      return "Recorded the earlier evidence. Continue with the latest request.";
    }
    if (catalogHandoff) {
      const compacted = request.messages.some(
        (entry) => entry.role === "user" && entry.text === CHECKPOINT_MARKER,
      );
      if (
        compacted ||
        request.toolResults.some((result) => result.name === "record-catalog-handoff")
      ) {
        const completed = request.messages.some(
          (entry, index) =>
            entry.text.includes(CATALOG_HANDOFF_MARKER) &&
            (entry.role === "tool" ||
              (entry.role === "assistant" &&
                request.messages[index - 1]?.role === "user" &&
                request.messages[index - 1]?.text === CHECKPOINT_MARKER)),
        );
        return {
          text: completed ? "RECENT_TOOL_EVIDENCE_KEPT" : "RECENT_TOOL_EVIDENCE_MISSING",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return {
        toolCalls: [{ id: "record-catalog-handoff-1", name: "record-catalog-handoff", input: {} }],
        usage: { inputTokens: 30_000, outputTokens: 1 },
      };
    }
    const message = request.lastUserMessage ?? "";
    if (message.includes("verify")) {
      return {
        text: request.messages.some((entry) => entry.text === "Summary of our conversation so far:")
          ? "MEASURED_COMPACTION_OK"
          : "MEASURED_COMPACTION_MISSING",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return {
      text: "Evidence recorded.",
      usage: { inputTokens: message.includes("report high usage") ? 30_000 : 1, outputTokens: 1 },
    };
  },
});

export default defineAgent({
  ...e2eAgentConfig(),
  model,
  modelContextWindowTokens: 100_000,
  compaction: { thresholdPercent: 0.2 },
});
