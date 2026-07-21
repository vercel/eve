import { defineAgent, type AgentDefinition } from "eve";
import { mockModel, type MockModelRequest } from "eve/evals";

import { SECOND_CHECKPOINT_MARKER } from "./constants";

const TEST_CONTEXT_WINDOW_TOKENS = 32_000;
const MAX_TOOL_CALLS = 10;

export type ModelFamily = "gpt-5.6" | "opus-4.8" | "sonnet-5";
type RegressionCase = "redundant-tool-calls" | "stale-todo-work";

interface ActiveRegression {
  readonly regressionCase: RegressionCase;
}

export function createCompactionRegressionAgent(input: {
  readonly compactionModel: string;
  readonly modelFamily: ModelFamily;
}): AgentDefinition {
  let activeRegression: ActiveRegression | undefined;
  const checkpointAdvanceCallCounts = new Map<RegressionCase, number>();
  const toolCallCounts = new Map<RegressionCase, number>();
  const taskModel = mockModel({
    modelId: `compaction-regression-task-model-${input.modelFamily}`,
    respond(request) {
      const initialRegression = findInitialRegression(request, input.modelFamily);
      if (
        initialRegression !== undefined &&
        activeRegression?.regressionCase !== initialRegression.regressionCase
      ) {
        activeRegression = initialRegression;
        checkpointAdvanceCallCounts.set(initialRegression.regressionCase, 0);
        toolCallCounts.set(initialRegression.regressionCase, 0);
      }

      if (activeRegression === undefined) {
        throw new Error("Compaction regression task model received no case marker.");
      }

      const regression = activeRegression;
      const marker = completionMarker(regression.regressionCase);

      // These are fixture markers, not compaction protocol fields. `marker` records the
      // regression work tool; `SECOND_CHECKPOINT_MARKER` records the test-only tool
      // whose output makes the harness cross the compaction threshold a second time.
      if (checkpointContains(request.messages, marker)) {
        if (checkpointContains(request.messages, SECOND_CHECKPOINT_MARKER)) {
          return `Done: ${marker}; ${SECOND_CHECKPOINT_MARKER}`;
        }

        const advanceCalls = checkpointAdvanceCallCounts.get(regression.regressionCase) ?? 0;
        if (advanceCalls >= MAX_TOOL_CALLS) {
          return `Hard stop after ${MAX_TOOL_CALLS} checkpoint advances: ${marker}`;
        }

        checkpointAdvanceCallCounts.set(regression.regressionCase, advanceCalls + 1);
        return {
          toolCalls: [
            {
              id: `advance-checkpoint-${advanceCalls + 1}`,
              input: {
                modelFamily: input.modelFamily,
                regressionCase: regression.regressionCase,
              },
              name: "advance-checkpoint",
            },
          ],
        };
      }

      const completedCalls = toolCallCounts.get(regression.regressionCase) ?? 0;
      if (completedCalls >= MAX_TOOL_CALLS) {
        return `Hard stop after ${MAX_TOOL_CALLS} calls: ${marker}`;
      }

      const attempt = completedCalls + 1;
      toolCallCounts.set(regression.regressionCase, attempt);

      return regression.regressionCase === "redundant-tool-calls"
        ? {
            toolCalls: [
              {
                id: `inspect-repository-${attempt}`,
                input: { modelFamily: input.modelFamily, scope: "repository" },
                name: "inspect-repository",
              },
            ],
          }
        : {
            toolCalls: [
              {
                id: `perform-source-analysis-${attempt}`,
                input: { approach: `attempt-${attempt}`, modelFamily: input.modelFamily },
                name: "perform-source-analysis",
              },
            ],
          };
    },
  });

  return defineAgent({
    model: taskModel,
    modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
    compaction: {
      model: input.compactionModel,
      modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
      thresholdPercent: 0.02,
    },
    limits: {
      maxInputTokensPerSession: 100_000,
    },
  });
}

function findInitialRegression(
  request: MockModelRequest,
  modelFamily: ModelFamily,
): ActiveRegression | undefined {
  for (const message of request.userMessages) {
    if (!message.includes(`[model: ${modelFamily}]`)) continue;

    const regressionCase = regressionCaseFromText(message);
    if (regressionCase !== undefined) return { regressionCase };
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
