import { openApprovalsOf } from "#harness/hitl/approval.js";
import { STATE_KEY, LEGACY_BATCH_KEY as LEGACY_KEY } from "./migrate-legacy.js";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  AT,
  BOB,
  answer,
  callback,
  challenge,
  Turn,
  approval,
  approvalsRequested,
  cancel,
} from "#internal/testing/hitl.js";

// One model step can make calls that wait on a person (approvals, authorizations)
// and calls that run as runtime work (`build`, a workflow tool). The step is
// held out of history, in one place, until every call it made has a result.

const buildTask = {
  callId: "call-build",
  entry: { entryPoint: "execute" as const },
  input: {},
  kind: "workflow-task" as const,
  toolName: "build",
  workflowId: "workflow//./agent/tools/build//execute",
};

function call(toolCallId: string, toolName: string) {
  return { input: {}, toolCallId, toolName, type: "tool-call" as const };
}

function result(toolCallId: string, toolName: string, value: string) {
  return {
    output: { type: "text" as const, value },
    toolCallId,
    toolName,
    type: "tool-result" as const,
  };
}

const built: ModelMessage = { content: [result("call-build", "build", "built")], role: "tool" };

/** The step's response: its calls, with a result for the authorization call that asked. */
function response(...calls: ReturnType<typeof call>[]): ModelMessage[] {
  const asked = calls.filter((c) => c.toolName === "weather");
  return [
    { content: calls, role: "assistant" },
    ...(asked.length === 0
      ? []
      : [
          {
            content: asked.map((c) => result(c.toolCallId, c.toolName, "Authorize first.")),
            role: "tool" as const,
          },
        ]),
  ];
}

function unpaired(messages: readonly ModelMessage[]): string[] {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const part of m.content) {
      if (part.type === "tool-call") called.add(part.toolCallId);
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  return [
    ...[...called].filter((id) => !answered.has(id)).map((id) => `call without result: ${id}`),
    ...[...answered].filter((id) => !called.has(id)).map((id) => `result without call: ${id}`),
  ];
}

describe("a session parked on runtime calls under the old coordination key", () => {
  const legacyBatch = {
    event: AT,
    followingInput: { message: "Then tell me." },
    responseMessages: response(call("call-build", "build")),
    tasks: [buildTask],
  };

  it("reads as the held step, and the next commit moves it there", () => {
    const state = { [LEGACY_KEY]: legacyBatch };

    expect(Turn.from(state).humanInput.runtimeCalls()).toEqual({
      at: AT,
      calls: [{ callId: "call-build", toolName: "build", waitsOn: "runtime" }],
      taskToolCalls: [],
      tasks: [buildTask],
    });

    const settled = Turn.from(state).input({ results: [built], type: "actions.settled" });
    expect(settled.state?.[LEGACY_KEY]).toBeUndefined();
    expect(settled.events).toEqual([
      ...legacyBatch.responseMessages.map((m) => ({ message: m, type: "appendHistory" })),
      { message: built, type: "appendHistory" },
    ]);
    expect(settled.input({ type: "input.resumed" }).events).toEqual([
      { input: { message: "Then tell me." }, type: "resumeInput" },
    ]);
  });

  it("joins the approvals' step it parked beside, whose response the batch held", () => {
    const messages = response(call("call-deploy", "deploy"), call("call-build", "build"));
    // Before, the approvals' step was empty while the batch held its response.
    const held = Turn.idle().input(approvalsRequested([approval("deploy")], { messages: [] }));
    const state = {
      [STATE_KEY]: {
        grants: held.stored().projected.turn.grants,
        requests: Object.fromEntries(
          openApprovalsOf(held.stored().projected).map((open) => [open.request.requestId, open]),
        ),
        held: { at: AT, messages: [] },
      },
      [LEGACY_KEY]: { ...legacyBatch, responseMessages: messages },
    };

    const read = Turn.from(state).humanInput;
    expect(read.heldMessages()).toEqual(messages);
    expect(read.heldCalls()?.calls.map((c) => [c.callId, c.waitsOn])).toEqual([
      ["call-build", "runtime"],
      ["call-deploy", "person"],
    ]);

    const cancelled = Turn.from(state).input(cancel);
    expect(
      unpaired(cancelled.events.flatMap((e) => (e.type === "appendHistory" ? [e.message] : []))),
    ).toEqual([]);
  });

  it("cancels an approval parked with its call already in history, answering the call as not run", () => {
    // Before steps were held out of history, the asking step joined history
    // and only the approval was stored.
    const asked = Turn.idle()
      .input(approvalsRequested([approval("deploy")]))
      .stored();
    const stored = {
      grants: asked.projected.turn.grants,
      requests: Object.fromEntries(
        openApprovalsOf(asked.projected).map((open) => [open.request.requestId, open]),
      ),
    };
    const history = response(call("call-deploy", "deploy"));

    const cancelled = Turn.from({ [STATE_KEY]: stored }).input(cancel);
    const appended = cancelled.events.flatMap((e) =>
      e.type === "appendHistory" ? [e.message] : [],
    );

    expect(unpaired([...history, ...appended])).toEqual([]);
    expect(appended).toEqual([
      {
        content: [
          {
            output: { reason: "Cancelled before anyone answered.", type: "execution-denied" },
            toolCallId: "call-deploy",
            toolName: "deploy",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
  });
});

it("a session stored while a responder's authorization was a request of its own reads it as the candidate's", () => {
  const authorization = Turn.idle()
    .input(approvalsRequested([approval("deploy")], { responsePolicyRequestIds: ["deploy"] }))
    .checked(answer("approve", "deploy", BOB), {
      challenges: [challenge("r1", { name: "reviewer", principalId: "bob", requester: BOB })],
      kind: "threw",
    })
    .stored();
  const answered = authorization.projected;
  const [candidateId, candidate] = Object.entries(answered.turn.hitl!.audit!.activeCandidates)[0]!;
  const { authorizations, ...waiting } = candidate;
  const legacy = Turn.from({
    [STATE_KEY]: {
      grants: answered.turn.grants,
      held: {
        at: answered.turn.suspended[0]!.event,
        messages: answered.turn.suspended[0]!.messages,
      },
      audit: { ...answered.turn.hitl!.audit, activeCandidates: { [candidateId]: waiting } },
      requests: {
        deploy: {
          at: AT,
          kind: "tool-approval",
          request: approval("deploy"),
          requester: answered.turn.suspended[0]!.requester,
          approvalKey: "deploy",
          responsePolicy: true,
        },
        r1: { at: AT, challenge: authorizations![0], kind: "authorization" },
      },
    },
  });

  expect(legacy.humanInput.awaitedAuthorizations()).toEqual(["r1"]);
  expect(legacy.humanInput.openRequestIds()).toEqual(new Set(["deploy"]));
  expect(legacy.checks(callback("r1", "reviewer"))).toEqual([
    expect.objectContaining({ candidateId, responder: BOB }),
  ]);
});

it("hydrates shared legacy batch metadata into live request ownership", () => {
  const batch = { requestIds: ["question-1", "approval-1"], approvalRequestIds: ["approval-1"] };
  const turn = Turn.from({
    "eve.runtime.proxyInputRequests": {
      "question-1": {
        batch,
        childContinuationToken: "child-a",
        event: AT,
        kind: "question",
        question: {},
      },
      "approval-1": { batch, childContinuationToken: "child-a", event: AT, kind: "tool-approval" },
    },
  }).stored();
  expect(turn.humanInput.relayedRequestIds()).toEqual(new Set(batch.requestIds));
  const answered = turn.input({
    type: "delivery.received",
    responses: [{ requestId: "approval-1", optionId: "approve" }],
  });
  expect(answered.reported("forwardAnswer")).toEqual([
    {
      type: "forwardAnswer",
      route: { childContinuationToken: "child-a" },
      responses: [{ requestId: "approval-1", optionId: "approve" }],
    },
  ]);
  expect(answered.resolutions()).toEqual([
    { kind: "question", outcome: "ignored", requestId: "question-1" },
    {
      kind: "tool-approval",
      outcome: "approved",
      requestId: "approval-1",
      response: { requestId: "approval-1", optionId: "approve" },
    },
  ]);
});
