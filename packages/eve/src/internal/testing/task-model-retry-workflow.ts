/**
 * Test fixture exercising task-mode model failures inside a real Workflow
 * step, including retry from a committed durable session snapshot.
 */
import type { LanguageModel, ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
import { createBootstrapGenerateResult } from "#runtime/agent/bootstrap-model-utils.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";

const MODEL_ID = "task-model-retry-fixture";
const PRIOR_HISTORY: readonly ModelMessage[] = [
  { content: "Complete the delegated task.", role: "user" },
  { content: "Prior durable work is complete.", role: "assistant" },
];

function createTurnAgent(): RuntimeTurnAgent {
  return {
    id: "task-model-retry-fixture",
    instructions: ["You are a test assistant."],
    model: { id: MODEL_ID },
    tools: [],
    workspaceSpec: { rootEntries: [] },
  };
}

/** Creates the committed snapshot each retry must read. */
export async function createTaskModelRetrySessionStep(input: {
  readonly sessionId: string;
}): Promise<DurableSessionState> {
  "use step";

  const session: HarnessSession = {
    agent: {
      modelReference: { id: MODEL_ID },
      system: "You are a test assistant.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: `subagent:${input.sessionId}`,
    history: [...PRIOR_HISTORY],
    sessionId: input.sessionId,
  };

  return createDurableSessionState({ session });
}

export interface TaskModelRetryStepResult {
  readonly attempt: number;
  readonly historyBeforeModelCall: readonly ModelMessage[];
  readonly history: readonly ModelMessage[];
  readonly output: string;
}

/** Runs one task-mode model call and lets Workflow retry recoverable failures. */
export async function taskModelRetryStep(input: {
  readonly failThroughAttempt: number;
  readonly sessionState: DurableSessionState;
}): Promise<TaskModelRetryStepResult> {
  "use step";

  const { attempt } = getStepMetadata();
  const durable = await readDurableSession(input.sessionState);
  const session = hydrateDurableSession({ durable, turnAgent: createTurnAgent() });
  const historyBeforeModelCall = [...session.history];
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      if (attempt <= input.failThroughAttempt) {
        throw new Error(`recoverable task failure on Workflow attempt ${String(attempt)}`);
      }

      return createBootstrapGenerateResult({
        inputTokens: 1,
        modelId: MODEL_ID,
        outputTokens: 1,
        text: "Recovered task output.",
      });
    },
    modelId: MODEL_ID,
    provider: "eve-integration-mock",
  });
  const runStep = createToolLoopHarness({
    mode: "task",
    resolveModel: async (): Promise<LanguageModel> => model,
    tools: new Map(),
  });

  const result = await runStep(session, { message: "Continue the delegated task." });

  if (result.next === null || typeof result.next === "function") {
    throw new Error("Task model retry fixture expected a completed task result.");
  }
  if (typeof result.next.output !== "string") {
    throw new Error("Task model retry fixture expected a string task output.");
  }

  return {
    attempt,
    history: result.session.history,
    historyBeforeModelCall,
    output: result.next.output,
  };
}

/** Represents the single parent-facing failure handoff after retry exhaustion. */
export async function recordTaskModelFailureForParentStep(input: {
  readonly message: string;
}): Promise<{ readonly count: 1; readonly message: string }> {
  "use step";

  return { count: 1, message: input.message };
}

export type TaskModelRetryFixtureResult =
  | {
      readonly kind: "completed";
      readonly parentNotifications: 0;
      readonly result: TaskModelRetryStepResult;
    }
  | {
      readonly failureMessage: string;
      readonly kind: "failed";
      readonly parentNotifications: 1;
    };

/** Drives the task step and handles only its final, post-retry failure. */
export async function taskModelRetryFixtureWorkflow(input: {
  readonly failThroughAttempt: number;
}): Promise<TaskModelRetryFixtureResult> {
  "use workflow";

  const { workflowRunId: sessionId } = getWorkflowMetadata();
  const sessionState = await createTaskModelRetrySessionStep({ sessionId });

  try {
    const result = await taskModelRetryStep({
      failThroughAttempt: input.failThroughAttempt,
      sessionState,
    });
    return { kind: "completed", parentNotifications: 0, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const notification = await recordTaskModelFailureForParentStep({ message });
    return {
      failureMessage: notification.message,
      kind: "failed",
      parentNotifications: notification.count,
    };
  }
}
