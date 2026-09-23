import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import { stampTestEvent } from "#internal/testing/events.js";

vi.mock("#execution/tools/subagent/emit-event-step.js", () => ({
  emitSubagentEventStep: vi.fn(),
  dispatchSessionEventHooksStep: vi.fn(async (input) => ({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  })),
}));

import { expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { replaceDurableSessionSnapshot } from "#execution/durable-session-store.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { nextTurnDelivery } from "#execution/session/next-input.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  getProxyInputRequests,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import {
  findBackgroundWorkflowToolRun,
  registerWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { TaskView } from "#tasks/types.js";

it.each(["completed", "failed", "cancelled"] as const)(
  "records a parked parent's %s task and removes its question before reporting the cohort",
  async (status) => {
    vi.mocked(emitSubagentEventStep)
      .mockReset()
      .mockImplementation(async (input) => ({
        serializedContext: {},
        event: stampTestEvent(input.event),
        suppressed: false,
      }));
    let state = createTestSessionState();
    let session = state.snapshot.session;
    for (const taskId of ["A", "B"]) {
      session = registerWorkflowToolRun(session, {
        callId: taskId,
        toolName: "worker",
        lifetime: "session",
        origin: { turnId: "turn", stepIndex: 0 },
        address: { runId: taskId, hookToken: taskId },
        task: {
          taskId,
          metadata: { kind: "subagent", name: "worker" },
          dispatchContext: { auth: { current: null, initiator: null } },
        },
      });
    }
    session = {
      ...session,
      state: upsertProxyInputRequestState({
        state: session.state,
        forChildContinuationToken: "answer-A",
        entries: [
          [
            "question-A",
            {
              childContinuationToken: "answer-A",
              childRequestId: "question",
              kind: "question",
              taskId: "A",
            },
          ],
        ],
      }),
    };
    state = replaceDurableSessionSnapshot({ session, state });
    const cursor = new SessionStateCursor({
      inbox: { claimSessionHooks: async () => {} },
      sessionWritable: new WritableStream<Uint8Array>(),
      serializedContext: {},
      sessionState: state,
    });
    const queue = new SessionInputQueue();
    const a: TaskView = {
      taskId: "A",
      metadata: { kind: "subagent", name: "worker" },
      ...(status === "completed"
        ? { status, lastOutput: { type: "result", data: "done" } }
        : status === "failed"
          ? { status, lastOutput: { type: "error", data: "timeout" } }
          : { status }),
    };
    const notification = (view: TaskView): DeliverHookPayload => ({
      kind: "deliver",
      taskDeliveryId: `${view.taskId}:ready:${view.status}`,
      payloads: [{ message: "task outcome", task: { views: [view] } }],
    });
    queue.enqueueDelivery(notification(a));
    let reads = 0;
    const next = await nextTurnDelivery({
      cursor,
      queue,
      inbox: {
        hasPending: () => false,
        drain: () => [],
        onInterrupt: () => () => {},
        onDelivery: () => () => {},
        restore: () => {},
        async next() {
          // The owner is about to wait for B; A must already be settled without a model turn.
          reads++;
          const current = cursor.sessionState.snapshot.session;
          expect(findBackgroundWorkflowToolRun(current.state, "A")?.task.outcome).toEqual({
            status: a.status,
            lastOutput: a.lastOutput,
            usage: a.usage,
          });
          expect(getProxyInputRequests(current.state).size).toBe(0);
          expect(cursor.sessionState.hasProxyInputRequests).toBe(false);
          expect(queue.pendingCount).toBe(1);
          expect(emitSubagentEventStep).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
          return notification({
            taskId: "B",
            metadata: { kind: "subagent", name: "worker" },
            status: "completed",
            lastOutput: { type: "result", data: "done B" },
          });
        },
      },
    });
    expect(reads).toBe(1);
    expect(next).toMatchObject({
      kind: "turn",
      delivery: {
        payloads: [
          { message: expect.stringContaining("Background task A") },
          { message: expect.stringContaining("Background task B") },
        ],
      },
    });
    expect(queue.pendingCount).toBe(0);
  },
);

it.each(["completed", "failed", "cancelled"] as const)(
  "publishes a background subagent result only for a newly recorded success (%s)",
  async (status) => {
    vi.mocked(emitSubagentEventStep).mockReset();
    const initial = createTestSessionState();
    const metadata = { kind: "subagent", name: "researcher" };
    let sessionState = replaceDurableSessionSnapshot({
      state: initial,
      session: registerWorkflowToolRun(initial.snapshot.session, {
        callId: "original-call",
        toolName: "researcher",
        lifetime: "session",
        origin: { turnId: "turn", stepIndex: 0 },
        address: { runId: "run", hookToken: "hook" },
        task: {
          taskId: "task",
          metadata,
          dispatchContext: { auth: { current: null, initiator: null } },
        },
      }),
    });
    const view: TaskView = {
      taskId: "task",
      metadata,
      ...(status === "completed"
        ? { status, lastOutput: { type: "result", data: { answer: 42 } } }
        : status === "failed"
          ? { status, lastOutput: { type: "error", data: "failed" } }
          : { status }),
    };
    vi.mocked(emitSubagentEventStep).mockImplementation(async (input) => {
      expect(
        findBackgroundWorkflowToolRun(input.sessionState.snapshot.session.state, "task")?.task
          .outcome,
      ).toEqual({ status: view.status, lastOutput: view.lastOutput, usage: view.usage });
      return {
        serializedContext: input.serializedContext,
        event: stampTestEvent(input.event),
        suppressed: false,
      };
    });
    const deliver = async (outcome: TaskView) => {
      const result = await routeDeliverToChildren({
        delivery: { kind: "deliver", payloads: [{ task: { views: [outcome] } }] },
        serializedContext: {},
        sessionState,
        sessionWritable: new WritableStream<Uint8Array>(),
      });
      sessionState = result.sessionState;
    };
    await deliver(view);
    await deliver(view);
    // A late success must not replace a failed or cancelled task, nor republish a success.
    await deliver({
      taskId: "task",
      metadata,
      status: "completed",
      lastOutput: { type: "result", data: "late" },
    });
    expect(emitSubagentEventStep).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
    if (status === "completed") {
      expect(emitSubagentEventStep).toHaveBeenCalledWith(
        expect.objectContaining({
          event: {
            type: "subagent.completed",
            data: { callId: "original-call", subagentName: "researcher", output: '{"answer":42}' },
          },
        }),
      );
    }
    expect(
      findBackgroundWorkflowToolRun(sessionState.snapshot.session.state, "task")?.task.outcome,
    ).toEqual({ status: view.status, lastOutput: view.lastOutput, usage: view.usage });
  },
);
