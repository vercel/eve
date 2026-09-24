import { describe, expect, it, vi } from "vitest";

import { nextTurnDelivery } from "#execution/session/next-input.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionStateMap } from "#harness/types.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { encodeTaskCreator, holdTaskResult } from "#tasks/results.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "owner-1" }),
}));

const ALICE = {
  attributes: {},
  authenticator: "slack",
  principalId: "U-alice",
  principalType: "user",
};

function inboxOf(payloads: readonly SessionInboxPayload[]): SessionInbox {
  const remaining = [...payloads];
  return {
    claimedTokens: [],
    async claimSessionHook() {},
    async claimSessionHooks() {},
    drain: () => remaining.splice(0),
    hasPending: () => remaining.length > 0,
    async next() {
      const payload = remaining.shift();
      if (payload === undefined) throw new Error("Mock inbox exhausted.");
      return payload;
    },
    onDelivery: () => () => {},
    onInterrupt: () => () => {},
    restore() {},
  };
}

/** An owner holding one settled background result from Alice. */
function heldResultState(input: {
  readonly extraState?: SessionStateMap;
  readonly turnId?: string;
}): DurableSessionState {
  const record = createTaskRecord({
    creator: encodeTaskCreator({ auth: ALICE }),
    id: "remind-q4x1ze",
    kind: "workflow",
    mode: "background",
    name: "remind",
    status: "completed",
  });
  const held = holdTaskResult({ state: taskTableState([record]) }, record, {
    output: "Stand-up at 10.",
    status: "completed",
  });
  const base = createTestSessionState({ sessionId: "owner" });
  return {
    ...base,
    emissionState: { ...base.emissionState, turnId: input.turnId ?? "" },
    snapshot: {
      session: { ...base.snapshot.session, state: { ...held.state, ...input.extraState } },
    },
  };
}

function cursorFor(inbox: SessionInbox, sessionState: DurableSessionState) {
  return new SessionStateCursor({
    inbox,
    serializedContext: {},
    sessionState,
    sessionWritable: new WritableStream<Uint8Array>(),
  });
}

describe("result turns", () => {
  it("start as the creator when the session is idle", async () => {
    const inbox = inboxOf([]);

    const next = await nextTurnDelivery({
      cursor: cursorFor(inbox, heldResultState({})),
      inbox,
      queue: new SessionInputQueue(),
    });

    expect(next).toEqual({ creator: encodeTaskCreator({ auth: ALICE }), kind: "task-results" });
  });

  it("follow queued deliveries instead of coalescing with them", async () => {
    const inbox = inboxOf([]);
    const queue = new SessionInputQueue();
    queue.enqueueDelivery({ kind: "deliver", payloads: [{ message: "Also check the deploy." }] });

    const next = await nextTurnDelivery({
      cursor: cursorFor(inbox, heldResultState({})),
      inbox,
      queue,
    });

    expect(next).toMatchObject({
      delivery: { payloads: [{ message: "Also check the deploy." }] },
      kind: "turn",
    });
  });

  it.each([
    ["an open turn", { turnId: "turn_3" }],
    [
      "a turn parked on a question",
      { extraState: { "eve.runtime.pendingInputBatches": [{ requests: [] }] } },
    ],
  ])("wait while %s can still deliver them at a tool-step boundary", async (_label, input) => {
    const inbox = inboxOf([{ kind: "send", payload: { message: "Bob asks a question." } }]);

    const next = await nextTurnDelivery({
      cursor: cursorFor(inbox, heldResultState(input)),
      inbox,
      queue: new SessionInputQueue(),
    });

    expect(next).toMatchObject({ kind: "turn" });
  });
});
