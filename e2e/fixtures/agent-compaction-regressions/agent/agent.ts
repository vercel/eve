import { defineAgent } from "eve";
import { mockModel, type MockModelRequest } from "eve/evals";

import { SECOND_CHECKPOINT_MARKER } from "../constants";

const TEST_CONTEXT_WINDOW_TOKENS = 32_000;
const MAX_TOOL_CALLS = 10;

type RegressionCase = "redundant-tool-calls" | "stale-todo-work";

let activeCase: RegressionCase | undefined;
const checkpointAdvanceCallCounts = new Map<RegressionCase, number>();
const toolCallCounts = new Map<RegressionCase, number>();

const taskModel = mockModel({
  modelId: "compaction-regression-task-model",
  respond(request) {
    const initialCase = findInitialCase(request);
    if (initialCase !== undefined && activeCase !== initialCase) {
      activeCase = initialCase;
      checkpointAdvanceCallCounts.set(initialCase, 0);
      toolCallCounts.set(initialCase, 0);
    }

    if (activeCase === undefined) {
      throw new Error("Compaction regression task model received no case marker.");
    }

    const regressionCase = activeCase;
    const marker = completionMarker(regressionCase);

    // These are fixture markers, not compaction protocol fields. `marker` records the
    // regression work tool; `SECOND_CHECKPOINT_MARKER` records the test-only tool
    // whose output makes the harness cross the compaction threshold a second time.
    if (checkpointContains(request.messages, marker)) {
      if (checkpointContains(request.messages, SECOND_CHECKPOINT_MARKER)) {
        return `Done: ${marker}; ${SECOND_CHECKPOINT_MARKER}`;
      }

      const advanceCalls = checkpointAdvanceCallCounts.get(regressionCase) ?? 0;
      if (advanceCalls >= MAX_TOOL_CALLS) {
        return `Hard stop after ${MAX_TOOL_CALLS} checkpoint advances: ${marker}`;
      }

      checkpointAdvanceCallCounts.set(regressionCase, advanceCalls + 1);
      return {
        toolCalls: [
          {
            id: `advance-checkpoint-${advanceCalls + 1}`,
            input: { regressionCase },
            name: "advance-checkpoint",
          },
        ],
      };
    }

    const completedCalls = toolCallCounts.get(regressionCase) ?? 0;
    if (completedCalls >= MAX_TOOL_CALLS) {
      return `Hard stop after ${MAX_TOOL_CALLS} calls: ${marker}`;
    }

    const attempt = completedCalls + 1;
    toolCallCounts.set(regressionCase, attempt);

    return regressionCase === "redundant-tool-calls"
      ? {
          toolCalls: [
            {
              id: `inspect-repository-${attempt}`,
              input: { scope: "repository" },
              name: "inspect-repository",
            },
          ],
        }
      : {
          toolCalls: [
            {
              id: `perform-source-analysis-${attempt}`,
              input: { approach: `attempt-${attempt}` },
              name: "perform-source-analysis",
            },
          ],
        };
  },
});

export default defineAgent({
  model: taskModel,
  modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
  compaction: {
    model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
    modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
    thresholdPercent: 0.02,
  },
  limits: {
    maxInputTokensPerSession: 100_000,
  },
});

function findInitialCase(request: MockModelRequest): RegressionCase | undefined {
  for (const message of request.userMessages) {
    const regressionCase = regressionCaseFromText(message);
    if (regressionCase !== undefined) return regressionCase;
  }

  return undefined;
}

function regressionCaseFromText(text: string): RegressionCase | undefined {
  if (text.includes("[case: redundant-tool-calls]")) return "redundant-tool-calls";
  if (text.includes("[case: stale-todo-work]")) return "stale-todo-work";
  return undefined;
}

function completionMarker(regressionCase: RegressionCase): string {
  return regressionCase === "redundant-tool-calls"
    ? "REPOSITORY_INSPECTION_COMPLETE"
    : "SOURCE_ANALYSIS_COMPLETE";
}

function checkpointContains(messages: MockModelRequest["messages"], marker: string): boolean {
  return messages.some((message, index) => {
    if (message.role !== "user" || message.text !== "Summary of our conversation so far:") {
      return false;
    }

    const checkpoint = messages[index + 1];
    return checkpoint?.role === "assistant" && checkpoint.text.includes(marker);
  });
}
