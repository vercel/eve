import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { readStepState } from "#execution/session/step-decision.js";
import { withParkedStep } from "#internal/testing/session-machine.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

describe("readStepState", () => {
  const session: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [],
    sessionId: "test-session",
  };
  const waitCall: ModelMessage = {
    content: [
      { input: {}, toolCallId: "wait-call", toolName: TASK_WAIT_TOOL_NAME, type: "tool-call" },
    ],
    role: "assistant",
  };
  const deployRun: RuntimeWorkflowTaskRequest = {
    callId: "deploy-call",
    entry: { entryPoint: "execute" },
    input: { service: "api" },
    kind: "workflow-task",
    toolName: "deploy",
    workflowId: "workflow//./agent/tools/deploy//execute",
  };
  const parked = (tasks: readonly RuntimeWorkflowTaskRequest[]) =>
    withParkedStep(session, {
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      messages: [waitCall],
      tasks,
    });

  it("waits on a task tool call without dispatching anything", () => {
    expect(readStepState(parked([]), {}).calls).toMatchObject({
      callIds: ["wait-call"],
      dispatch: false,
    });
  });

  it("dispatches the workflow tool runs a batch holds beside its task tool calls", () => {
    expect(readStepState(parked([deployRun]), {}).calls).toMatchObject({
      callIds: ["deploy-call", "wait-call"],
      dispatch: true,
    });
  });
});
