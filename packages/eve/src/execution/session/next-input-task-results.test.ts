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
    mode: "detached",
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

describe("held task results in a parked session", () => {
  it("never start a turn: an idle session keeps waiting for input", async () => {
    const inbox = inboxOf([{ kind: "send", payload: { message: "Bob asks a question." } }]);

    const next = await nextTurnDelivery({
      cursor: cursorFor(inbox, heldResultState({})),
      inbox,
      queue: new SessionInputQueue(),
    });

    expect(next).toMatchObject({
      delivery: { payloads: [{ message: "Bob asks a question." }] },
      kind: "turn",
    });
  });

  it("never coalesce with queued deliveries", async () => {
    const inbox = inboxOf([]);
    const queue = new SessionInputQueue();
    queue.enqueueDelivery({ kind: "deliver", payloads: [{ message: "Also check the deploy." }] });

    const next = await nextTurnDelivery({
      cursor: cursorFor(inbox, heldResultState({})),
      inbox,
      queue,
    });

    expect(next).toEqual(
      expect.objectContaining({
        delivery: { kind: "deliver", payloads: [{ message: "Also check the deploy." }] },
        kind: "turn",
      }),
    );
  });
});
