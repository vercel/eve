import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { settleDirectApprovalResponse } from "#harness/approval-candidates.js";
import { coordinateApprovalDelivery } from "#harness/approval-delivery-coordinator.js";
import { appendPendingInputBatch } from "#harness/pending-input-batches.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#runtime/input/types.js";

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

  // #2182: each delivery's result carried only its newest response, so a
  // batch answered one response per delivery never resolved.
  it("reattaches earlier settlements when a later delivery settles another batch request", async () => {
    const batchRequest = (index: number): InputRequest => ({
      action: {
        callId: `call-${index}`,
        input: { marker: `note-${index}` },
        kind: "tool-call",
        toolName: "gate",
      },
      allowFreeform: false,
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Approve" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: `Approve tool call: gate (${index})`,
      requestId: `approval-${index}`,
    });
    const requests = [batchRequest(1), batchRequest(2), batchRequest(3)];
    let session: HarnessSession = appendPendingInputBatch({
      requests,
      responseMessages: [],
      session: {
        agent: { modelReference: { id: "test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 0.8 },
        continuationToken: "test",
        history: [],
        sessionId: "session-1",
      },
    });

    const respondedIds = (stepInput?: { inputResponses?: readonly { requestId: string }[] }) =>
      (stepInput?.inputResponses ?? []).map((response) => response.requestId).sort();

    let result;
    for (const [index, request] of requests.entries()) {
      result = await coordinateApprovalDelivery({
        now: 100 + index,
        session,
        stepInput: {
          attributedInputResponses: [
            {
              auth: responder,
              response: { optionId: "approve", requestId: request.requestId },
            },
          ],
        },
        tools: new Map(),
      });
      session = result.session;
      expect(result.kind).toBe("continue");
      // Every delivery result must carry this response plus every earlier
      // settlement, so the batch resolves the moment its last answer lands.
      expect(respondedIds(result.stepInput)).toEqual(
        requests.slice(0, index + 1).map((entry) => entry.requestId),
      );
    }
    expect(
      result?.stepInput?.inputResponses?.every((response) => response.optionId === "approve"),
    ).toBe(true);
  });
});
