import { expect, it } from "vitest";

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
          metadata: { kind: "tool", name: "worker" },
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
      metadata: { kind: "tool", name: "worker" },
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
          expect(findBackgroundWorkflowToolRun(current.state, "A")?.task.terminalView).toEqual(a);
          expect(getProxyInputRequests(current.state).size).toBe(0);
          expect(cursor.sessionState.hasProxyInputRequests).toBe(false);
          expect(queue.pendingCount).toBe(1);
          return notification({
            taskId: "B",
            metadata: { kind: "tool", name: "worker" },
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
