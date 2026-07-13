import { defineAgent, type AgentDefinition } from "eve";
import { gateway, type LanguageModel } from "ai";
import { mockModel, type MockModelRequest } from "eve/evals";

const TEST_CONTEXT_WINDOW_TOKENS = 32_000;
const MAX_TOOL_CALLS = 10;

type ModelFamily = "gpt-5.6" | "opus-4.8" | "sonnet-5";
type RegressionCase = "redundant-tool-calls" | "stale-todo-work";

interface ActiveRegression {
  readonly modelFamily: ModelFamily;
  readonly regressionCase: RegressionCase;
}

type GatewayModel = ReturnType<typeof gateway>;

const gptCompactionModel: GatewayModel = gateway("openai/gpt-5.6-sol");
const opusCompactionModel: GatewayModel = gateway("anthropic/claude-opus-4.8");
const sonnetCompactionModel: GatewayModel = gateway("anthropic/claude-sonnet-5");

const compactionModel: LanguageModel = {
  modelId: "compaction-regression-router",
  provider: "gateway",
  specificationVersion: "v4",
  supportedUrls: {},
  doGenerate(options: Parameters<typeof gptCompactionModel.doGenerate>[0]) {
    return selectCompactionModel(JSON.stringify(options.prompt)).doGenerate(options);
  },
  doStream(options: Parameters<typeof gptCompactionModel.doStream>[0]) {
    return selectCompactionModel(JSON.stringify(options.prompt)).doStream(options);
  },
};

let activeRegression: ActiveRegression | undefined;
const toolCallCounts = new Map<string, number>();

const taskModel: LanguageModel = mockModel({
  modelId: "compaction-regression-task-model",
  respond(request) {
    const initialRegression = findInitialRegression(request);
    if (initialRegression !== undefined) {
      activeRegression = initialRegression;
      toolCallCounts.set(regressionKey(initialRegression), 0);
    }

    if (activeRegression === undefined) {
      throw new Error("Compaction regression task model received no case marker.");
    }

    const regression = activeRegression;
    const marker = completionMarker(regression.regressionCase);
    const promptText = request.messages.map((message) => message.text).join("\n");
    const staleTodoIsPending =
      regression.regressionCase === "stale-todo-work" &&
      request.lastUserMessage?.includes("[ ] [high] Complete source analysis") === true;

    if (checkpointProvesCompletion(promptText, marker) && !staleTodoIsPending) {
      return `Done: ${marker}`;
    }

    const key = regressionKey(regression);
    const completedCalls = toolCallCounts.get(key) ?? 0;
    if (completedCalls >= MAX_TOOL_CALLS) {
      return `Hard stop after ${MAX_TOOL_CALLS} calls: ${marker}`;
    }

    const attempt = completedCalls + 1;
    toolCallCounts.set(key, attempt);

    return regression.regressionCase === "redundant-tool-calls"
      ? {
          toolCalls: [
            {
              input: { modelFamily: regression.modelFamily, scope: "repository" },
              name: "inspect-repository",
            },
          ],
        }
      : {
          toolCalls: [
            {
              input: { approach: `attempt-${attempt}`, modelFamily: regression.modelFamily },
              name: "perform-source-analysis",
            },
          ],
        };
  },
});

const agent: AgentDefinition = defineAgent({
  model: taskModel,
  modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
  compaction: {
    model: compactionModel,
    modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
    thresholdPercent: 0.02,
  },
  limits: {
    maxInputTokensPerSession: 100_000,
  },
});

export default agent;

function findInitialRegression(request: MockModelRequest): ActiveRegression | undefined {
  for (const message of request.userMessages) {
    const modelFamily = modelFamilyFromText(message);
    const regressionCase = regressionCaseFromText(message);
    if (modelFamily !== undefined && regressionCase !== undefined) {
      return { modelFamily, regressionCase };
    }
  }

  return undefined;
}

function modelFamilyFromText(text: string): ModelFamily | undefined {
  if (text.includes("[model: gpt-5.6]")) return "gpt-5.6";
  if (text.includes("[model: opus-4.8]")) return "opus-4.8";
  if (text.includes("[model: sonnet-5]")) return "sonnet-5";
  return undefined;
}

function regressionCaseFromText(text: string): RegressionCase | undefined {
  if (text.includes("[case: redundant-tool-calls]")) return "redundant-tool-calls";
  if (text.includes("[case: stale-todo-work]")) return "stale-todo-work";
  return undefined;
}

function selectCompactionModel(prompt: string): GatewayModel {
  const modelFamily = modelFamilyFromText(prompt);
  switch (modelFamily) {
    case "gpt-5.6":
      return gptCompactionModel;
    case "opus-4.8":
      return opusCompactionModel;
    case "sonnet-5":
      return sonnetCompactionModel;
    default:
      throw new Error("Compaction prompt contains no model-family marker.");
  }
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

function regressionKey(regression: ActiveRegression): string {
  return `${regression.modelFamily}:${regression.regressionCase}`;
}
