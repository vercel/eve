import { describe, expect, it, vi } from "vitest";

import { detachEveAgentStore, EveAgentStore } from "#client/eve-agent-store.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createApprovalCandidateEvent,
  createSessionWaitingEvent,
  EVE_MESSAGE_STREAM_VERSION,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

function controlledStreamResponse() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    }),
    { headers: { "x-eve-stream-version": EVE_MESSAGE_STREAM_VERSION } },
  );

  return {
    close: () => controller?.close(),
    emit: (event: MessageStreamEvent) => controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
    response,
  };
}

function acceptedResponse(deliveryId = "delivery_1"): Response {
  return Response.json(
    { deliveryId, ok: true, sessionId: "session_1", status: "accepted" },
    { status: 202 },
  );
}

function fetchFor(live: ReturnType<typeof controlledStreamResponse>) {
  return async (request: RequestInfo | URL, init?: RequestInit) => {
    return init?.method === "POST" ? acceptedResponse() : live.response;
  };
}

function rejectedApprovalEvents(): MessageStreamEvent[] {
  return stampTestEvents([
    createSessionWaitingEvent(),
    createApprovalCandidateEvent({
      candidateId: "candidate_1",
      outcome: "rejected",
      reason: "This responder may not approve.",
      requestId: "approval_1",
      responderPrincipalId: "user_1",
      sequence: 0,
      stepIndex: 0,
      turnId: "parked_turn_1",
    }),
  ] as UnstampedMessageStreamEvent[]);
}

describe("issue #3757 reproduction", () => {
  it("returns the store to ready after a rejected approval candidate", async () => {
    const [waiting, rejected] = rejectedApprovalEvents();
    const live = controlledStreamResponse();
    const store = new EveAgentStore({
      initialEvents: [waiting!],
      initialSession: { sessionId: "session_1", streamIndex: 1 },
      reducer: defaultMessageReducer(),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchFor(live));
    const responding = store.send({ inputResponses: [{ optionId: "approve", requestId: "approval_1" }] });

    try {
      await vi.waitFor(() => expect(store.snapshot.status).toBe("submitted"));
      live.emit({ ...rejected!, meta: { ...rejected!.meta, deliveryIds: ["delivery_1"] } });
      await vi.waitFor(() => expect(store.snapshot.status).toBe("ready"), { timeout: 100 });
      await responding;
    } finally {
      live.close();
      detachEveAgentStore(store);
      await Promise.allSettled([responding]);
      vi.restoreAllMocks();
    }
  });
});
