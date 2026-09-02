import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  createRequests,
  consumeDeferredStepInput,
  openRequestIds,
  resolvePendingInput,
} from "#harness/input-requests.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import {
  listReadyRequestGroupDeliveries,
  readRequestLedger,
} from "#harness/hitl/request-ledger.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

function session(): HarnessSession {
  return {
    agent: { modelReference: {} as never, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "test",
    history: [],
    sessionId: "session-1",
  };
}

function approval(requestId: string): InputRequest {
  return {
    action: { callId: `${requestId}-call`, input: {}, kind: "tool-call", toolName: "bash" },
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: "Approve bash",
    requestId,
  };
}

function question(requestId: string): InputRequest {
  return {
    action: {
      callId: `${requestId}-call`,
      input: {},
      kind: "tool-call",
      toolName: "ask_question",
    },
    display: "text",
    kind: "question",
    prompt: "What next?",
    requestId,
  };
}

function responseMessages(requests: readonly InputRequest[]): ModelMessage[] {
  return [
    {
      content: requests.map((request) => ({
        input: request.action.input,
        toolCallId: request.action.callId,
        toolName: request.action.toolName,
        type: "tool-call" as const,
      })),
      role: "assistant",
    },
  ];
}

function appendGroup(current: HarnessSession, requests: readonly InputRequest[]): HarnessSession {
  return createRequests({
    requests,
    responseMessages: responseMessages(requests),
    session: current,
  });
}

describe("current HITL lifecycle conformance", () => {
  it("keeps a mixed group open until its approval is answered", () => {
    const requests = [question("question-1"), approval("approval-1")];
    const parked = appendGroup(session(), requests);

    const result = resolvePendingInput({
      session: parked,
      stepInput: { inputResponses: [{ optionId: "yes", requestId: "question-1" }] },
    });

    expect(result.outcome).toBe("unresolved");
    expect(openRequestIds(result.session.state)).toEqual(new Set(["question-1", "approval-1"]));
    expect(consumeDeferredStepInput({ session: result.session }).input).toEqual({
      inputResponses: [{ optionId: "yes", requestId: "question-1" }],
    });
  });

  it("settles a mixed group when its approval is answered and dismisses an unanswered question", () => {
    const requests = [question("question-1"), approval("approval-1")];
    const parked = appendGroup(session(), requests);

    const result = resolvePendingInput({
      session: parked,
      stepInput: { inputResponses: [{ optionId: "approve", requestId: "approval-1" }] },
    });

    expect(result.outcome).toBe("resolved");
    expect(openRequestIds(result.session.state)).toEqual(new Set());
    expect(result.messages.at(-1)).toEqual({
      content: expect.arrayContaining([
        expect.objectContaining({
          output: { type: "json", value: { status: "ignored" } },
          toolCallId: "question-1-call",
          type: "tool-result",
        }),
        expect.objectContaining({
          approvalId: "approval-1",
          approved: true,
          type: "tool-approval-response",
        }),
      ]),
      role: "tool",
    });
  });

  it("answers an independent question group while an approval group remains open", () => {
    let parked = appendGroup(session(), [approval("approval-1")]);
    parked = appendGroup(parked, [question("question-1")]);

    const result = resolvePendingInput({
      session: parked,
      stepInput: { inputResponses: [{ text: "later", requestId: "question-1" }] },
    });

    expect(result.outcome).toBe("resolved");
    expect(openRequestIds(result.session.state)).toEqual(new Set(["approval-1"]));
  });

  it("uses the last response when one delivery repeats a request id", () => {
    const parked = appendGroup(session(), [approval("approval-1")]);

    const result = resolvePendingInput({
      session: parked,
      stepInput: {
        inputResponses: [
          { optionId: "cancel", requestId: "approval-1" },
          { optionId: "approve", requestId: "approval-1" },
        ],
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.messages.at(-1)).toEqual({
      content: [
        expect.objectContaining({
          approvalId: "approval-1",
          approved: true,
          type: "tool-approval-response",
        }),
      ],
      role: "tool",
    });
  });

  it("checkpoints ready completion before replaying and acknowledging owner delivery", () => {
    const parked = appendGroup(session(), [question("question-1")]);
    const input = {
      durableGroupCompletionDelivery: true,
      session: parked,
      stepInput: { inputResponses: [{ text: "later", requestId: "question-1" }] },
    } as const;

    const prepared = resolvePendingInput(input);
    expect(prepared.outcome).toBe("ready");
    expect(listReadyRequestGroupDeliveries(prepared.session.state)).toHaveLength(1);
    expect(readRequestLedger(prepared.session.state).groups[0]?.completion).toEqual(
      expect.objectContaining({ status: "ready" }),
    );

    const delivered = resolvePendingInput({
      durableGroupCompletionDelivery: true,
      session: prepared.session,
    });
    const retried = resolvePendingInput({
      durableGroupCompletionDelivery: true,
      session: prepared.session,
    });

    expect(delivered.outcome).toBe("resolved");
    expect(delivered.groupCompletionDelivery).toEqual(
      expect.objectContaining({
        targets: [{ groupId: "session-turn:0", owner: "session-turn" }],
      }),
    );
    expect(retried.messages).toEqual(delivered.messages);
    expect(readRequestLedger(delivered.session.state).groups[0]?.completion).toEqual(
      expect.objectContaining({ status: "ready" }),
    );
  });

  it("gives an open limit group priority over responses for another group", () => {
    let parked = appendGroup(session(), [approval("approval-1")]);
    parked = createRequests({
      requests: [
        createSessionLimitContinuationRequest({
          sessionId: "session-1",
          violation: { kind: "input", limit: 10, usedTokens: 10 },
        }),
      ],
      responseMessages: [],
      session: parked,
    });

    const result = resolvePendingInput({
      session: parked,
      stepInput: { inputResponses: [{ optionId: "approve", requestId: "approval-1" }] },
    });

    expect(result.outcome).toBe("unresolved");
    expect(openRequestIds(result.session.state)).toEqual(
      new Set(["approval-1", "session-1:limit:input:10"]),
    );
    expect(consumeDeferredStepInput({ session: result.session }).input).toEqual({
      inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
    });
  });
});
