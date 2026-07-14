import { defineAgent, type AgentDefinition } from "eve";
import { mockModel, type MockModelRequest } from "eve/evals";

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
        toolCallCounts.set(initialRegression.regressionCase, 0);
      }

      if (activeRegression === undefined) {
        throw new Error("Compaction regression task model received no case marker.");
      }

      const regression = activeRegression;
      const marker = completionMarker(regression.regressionCase);
      const promptText = request.messages.map((message) => message.text).join("\n");

      if (checkpointProvesCompletion(promptText, marker)) {
        return `Done: ${marker}`;
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
                input: { modelFamily: input.modelFamily, scope: "repository" },
                name: "inspect-repository",
              },
            ],
          }
        : {
            toolCalls: [
              {
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

function checkpointProvesCompletion(text: string, marker: string): boolean {
  const requiredSections = [
    "## Goal",
    "## Constraints and preferences",
    "## Progress",
    "### Done",
    "### In progress",
    "### Blocked",
    "## Key decisions",
    "## Next steps",
    "## Critical context",
  ];
  if (!requiredSections.every((section) => text.includes(section))) return false;

  const start = text.lastIndexOf("### Done");
  const end = text.indexOf("### In progress", start);
  return text.slice(start, end < 0 ? undefined : end).includes(marker);
}
