import { describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { turnStep } from "#execution/session/turn-step.js";
import { SessionExecution } from "#execution/session/turn.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { RunMode } from "#shared/run-mode.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: () => ({ url: "https://parent.example" }),
}));
vi.mock("#execution/session/turn-step.js", () => ({ turnStep: vi.fn() }));
vi.mock("#execution/session-workflow-tool-run.js", () => ({
  handleWorkflowToolRunMessage: vi.fn(async () => undefined),
}));

const OUTCOME: SessionInboxPayload = {
  from: {
    callId: "call-remind",
    runId: "run-1",
    sequence: 0,
    stepIndex: 0,
    taskId: "remind-abc234",
    toolName: "remind",
    turnId: "turn_0",
  },
  kind: "outcome",
  result: { output: "Stand-up at 10.", status: "completed" },
};

function inboxDraining(batches: SessionInboxPayload[][]): SessionInbox {
  return {
    claimedTokens: [],
    claimSessionHook: vi.fn(),
    claimSessionHooks: vi.fn(),
    drain: () => batches.shift() ?? [],
    hasPending: () => false,
    next: vi.fn(),
    onDelivery: () => () => {},
    onInterrupt: () => () => {},
    restore: vi.fn(),
  };
}

function ownerState(state?: Record<string, unknown>): DurableSessionState {
  const base = createTestSessionState({
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
    sessionId: "owner",
  });
  return { ...base, snapshot: { session: { ...base.snapshot.session, state } } };
}

function execution(inbox: SessionInbox, sessionState: DurableSessionState, mode: RunMode) {
  return new SessionExecution({
    cursor: new SessionStateCursor({
      inbox,
      serializedContext: {},
      sessionState,
      sessionWritable: new WritableStream<Uint8Array>(),
    }),
    inbox,
    mode,
    queue: new SessionInputQueue(),
    sessionId: "owner",
  });
}

describe("background results inside an active turn", () => {
  it("applies a background run's outcome admitted between model steps before the next step", async () => {
    const sessionState = ownerState();
    const order: string[] = [];
    vi.mocked(handleWorkflowToolRunMessage).mockImplementation(async () => {
      order.push("outcome");
      return undefined;
    });
    vi.mocked(turnStep)
      .mockImplementationOnce(async () => {
        order.push("step-1");
        return { action: "continue", serializedContext: {}, sessionState };
      })
      .mockImplementationOnce(async () => {
        order.push("step-2");
        return {
          action: "park",
          hasPendingAuthorization: false,
          hasPendingInputBatch: false,
          serializedContext: {},
          sessionState,
          settled: { output: "Done." },
        };
      });

    await execution(inboxDraining([[OUTCOME]]), sessionState, "conversation").runTurn(undefined);

    expect(order).toEqual(["step-1", "outcome", "step-2"]);
  });

  it("lets a task-mode run park while its background tasks are outstanding", async () => {
    const working = createTaskRecord({ kind: "workflow", mode: "background", name: "remind" });
    const sessionState = ownerState(taskTableState([working]));
    const settled = { output: "Started the reminder." };
    vi.mocked(turnStep).mockResolvedValueOnce({
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      serializedContext: {},
      sessionState,
      settled,
    });

    await expect(
      execution(inboxDraining([]), sessionState, "task").runTurn(undefined),
    ).resolves.toMatchObject({ kind: "park", settled });
  });
});
