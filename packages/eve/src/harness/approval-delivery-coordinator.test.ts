import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { settleDirectApprovalResponse } from "#harness/approval-candidates.js";
import {
  coordinateApprovalDelivery,
  shouldPrepareApprovalReplayTools,
} from "#harness/approval-delivery-coordinator.js";
import { appendPendingInputBatch, getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

const request: InputRequest = {
  action: { callId: "call-1", input: { marker: "durable" }, kind: "tool-call", toolName: "gate" },
  allowFreeform: false,
  display: "confirmation",
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  prompt: "Approve tool call: gate",
  requestId: "approval-1",
};
const responder: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "user-1",
  principalType: "user",
};

function parkedSession(): HarnessSession {
  return appendPendingInputBatch({
    requests: [request],
    responseAuthRequiredRequestIds: [request.requestId],
    responseMessages: [],
    session: {
      agent: { modelReference: { id: "test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 0.8 },
      continuationToken: "test",
      history: [],
      sessionId: "session-1",
    },
  });
}

describe("coordinateApprovalDelivery", () => {
  it("recovers an allowed settlement before its synthetic response is consumed", async () => {
    const parked = parkedSession();
    const settled = settleDirectApprovalResponse({
      actor: responder,
      outcome: "allowed",
      requestId: request.requestId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await coordinateApprovalDelivery({
      now: 101,
      session: { ...parked, state: settled.state },
      tools: new Map(),
    });
    expect(result.kind).toBe("continue");
    expect(result.stepInput?.inputResponses).toEqual([
      { optionId: "approve", requestId: request.requestId },
    ]);
  });

  it("recovers a cancelled settlement before its synthetic response is consumed", async () => {
    const parked = parkedSession();
    const settled = settleDirectApprovalResponse({
      actor: responder,
      outcome: "cancelled",
      requestId: request.requestId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await coordinateApprovalDelivery({
      now: 101,
      session: { ...parked, state: settled.state },
      tools: new Map(),
    });
    expect(result.kind).toBe("continue");
    expect(result.stepInput?.inputResponses).toEqual([
      { optionId: "cancel", requestId: request.requestId },
    ]);
  });

  it("forwards an unrelated message while a response-authorized approval remains pending", async () => {
    const messageAuth: SessionAuthContext = { ...responder, principalId: "user-2" };
    const result = await coordinateApprovalDelivery({
      now: 100,
      session: parkedSession(),
      stepInput: {
        message: "What else can you help with?",
        messageAuth,
      },
      tools: new Map(),
    });

    expect(result.kind).toBe("continue");
    expect(result.feedback).toEqual([]);
    expect(result.stepInput?.message).toBe("What else can you help with?");
    expect(result.stepInput?.messageAuth).toEqual(messageAuth);
    expect(
      getPendingInputBatches(result.session.state).flatMap((batch) =>
        batch.requests.map((pending) => pending.requestId),
      ),
    ).toEqual([request.requestId]);
  });
});

describe("text approval replay preparation", () => {
  function sessionWithRequests(
    requests: InputRequest[] = [request],
    responseAuthRequiredRequestIds?: string[],
  ) {
    const base = parkedSession();
    return appendPendingInputBatch({
      requests,
      responseAuthRequiredRequestIds,
      responseMessages: [],
      session: { ...base, state: undefined },
    });
  }

  it.each(["approve", "APPROVE", "1"])("prepares a matching text approval: %s", (message) => {
    expect(
      shouldPrepareApprovalReplayTools({ session: sessionWithRequests(), stepInput: { message } }),
    ).toBe(true);
  });

  it.each(["cancel", "unrelated follow-up"])("does not prepare tools for %s", (message) => {
    expect(
      shouldPrepareApprovalReplayTools({ session: sessionWithRequests(), stepInput: { message } }),
    ).toBe(false);
  });

  it("does not treat a question option named approve as tool approval", () => {
    expect(
      shouldPrepareApprovalReplayTools({
        session: sessionWithRequests([{ ...request, kind: "question" }]),
        stepInput: { message: "approve" },
      }),
    ).toBe(false);
  });

  it("does not bypass responder authorization with text", () => {
    expect(
      shouldPrepareApprovalReplayTools({
        session: sessionWithRequests([request], [request.requestId]),
        stepInput: { message: "approve" },
      }),
    ).toBe(false);
  });

  it("does not interpret text when multiple batches are pending", () => {
    const session = appendPendingInputBatch({
      requests: [{ ...request, requestId: "approval-2" }],
      responseMessages: [],
      session: sessionWithRequests(),
    });
    expect(shouldPrepareApprovalReplayTools({ session, stepInput: { message: "approve" } })).toBe(
      false,
    );
  });

  it("preserves an explicit cancellation over approval text", () => {
    expect(
      shouldPrepareApprovalReplayTools({
        session: sessionWithRequests(),
        stepInput: {
          message: "approve",
          inputResponses: [{ optionId: "cancel", requestId: request.requestId }],
        },
      }),
    ).toBe(false);
  });
});
