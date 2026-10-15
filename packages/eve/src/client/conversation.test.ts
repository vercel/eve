import { describe, expect, it } from "vitest";

import { Conversation, conversationOf } from "#client/conversation.js";
import type { EveMessagePart, EveToolPart } from "#client/message-types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { InteractionOrigin } from "#protocol/session-events/families/interaction.js";
import { stampTestEvent } from "#internal/testing/events.js";

const turnId = "turn_0";
const runId = "run_0";
const scope = { runId, turnId };

const started: SessionEvent[] = [
  { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
  {
    data: { cause: { deliveryId: "d_0" }, follows: null, turnId },
    scope: { turnId },
    type: "turn.started",
  },
  {
    data: { deliveryId: "d_0", parts: [{ kind: "text", text: "Deploy it." }], turnId },
    scope: { turnId },
    type: "delivery.consumed",
  },
  { data: { owner: { turnId }, runId }, scope, type: "model.requested" },
];

function text(partId: string, value: string): SessionEvent {
  return {
    data: { kind: "text", partId, phase: "narration", runId, value },
    scope,
    type: "content.completed",
  };
}

const requested: SessionEvent = {
  data: {
    callId: "call_0",
    capability: { kind: "tool", name: "deploy", label: "Deploying" },
    input: { env: "prod" },
    owner: { runId },
  },
  scope,
  type: "call.requested",
};

function approval(interactionId: string, origin?: InteractionOrigin): SessionEvent {
  return {
    data: {
      interactionId,
      request: {
        kind: "approval",
        options: [{ id: "approve", label: "Approve" }],
        prompt: "Deploy?",
      },
      subject: { callId: "call_0" },
      ...(origin !== undefined && { origin }),
    },
    scope,
    type: "interaction.opened",
  };
}

/** Folds events as a client receives them, one line each. */
function observe(events: readonly SessionEvent[], conversation = new Conversation()) {
  const start = conversation.view.position;
  events.forEach((event, index) => conversation.observe(stampTestEvent(event, start + index)));
  return conversation;
}

function assistantParts(conversation: Conversation): readonly EveMessagePart[] {
  return conversation.state.messages.find((message) => message.role === "assistant")?.parts ?? [];
}

function tool(conversation: Conversation): EveToolPart | undefined {
  return assistantParts(conversation).find((part): part is EveToolPart => part.type === "tool");
}

describe("the conversation", () => {
  it("shows a turn's parts and calls in the order the stream introduced them", () => {
    const conversation = observe([
      ...started,
      text("p_0", "Checking."),
      requested,
      text("p_1", "Done."),
    ]);
    expect(conversation.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(
      assistantParts(conversation).map((part) =>
        part.type === "text" ? part.text : part.type === "tool" ? part.callId : part.type,
      ),
    ).toEqual(["Checking.", "call_0", "Done."]);
  });

  it("shows what still streams as previews, until its fact completes it", () => {
    const conversation = observe([
      ...started,
      { data: { delta: "Check", kind: "text", partId: "p_0" }, scope, type: "content.delta" },
      { data: { callId: "call_0", delta: '{"env"', name: "deploy" }, scope, type: "call.input" },
    ]);
    expect(assistantParts(conversation)).toMatchObject([
      { state: "streaming", text: "Check", type: "text" },
      { inputText: '{"env"', name: "deploy", status: "streaming", type: "tool" },
    ]);

    observe([text("p_0", "Checking."), requested], conversation);
    expect(assistantParts(conversation)).toMatchObject([
      { state: "done", text: "Checking." },
      { input: { env: "prod" }, kind: "tool", label: "Deploying", status: "requested" },
    ]);
    expect(tool(conversation)?.inputText).toBeUndefined();
  });

  it("reads a call's part from its row: status, outcome, output, and label", () => {
    const conversation = observe([
      ...started,
      requested,
      { data: { callId: "call_0" }, scope, type: "call.started" },
      {
        data: { callId: "call_0", output: { done: 1 }, label: "Deployed 1 of 2" },
        scope,
        type: "call.progress",
      },
    ]);
    expect(tool(conversation)).toMatchObject({
      label: "Deployed 1 of 2",
      output: { done: 1 },
      status: "running",
    });

    observe(
      [
        {
          data: { callId: "call_0", outcome: "completed", output: { done: 2 }, label: "Deployed" },
          scope,
          type: "call.settled",
        },
      ],
      conversation,
    );
    expect(tool(conversation)).toMatchObject({
      label: "Deployed",
      outcome: "completed",
      output: { done: 2 },
      status: "settled",
    });
  });

  it("leaves out a call a retry replaced", () => {
    const conversation = observe([
      ...started,
      requested,
      { data: { callId: "call_0", outcome: "abandoned" }, scope, type: "call.settled" },
    ]);
    expect(tool(conversation)).toBeUndefined();
  });

  it("shows an approval on its call, and every other interaction as a part of its own", () => {
    const conversation = observe([
      ...started,
      requested,
      approval("approval_0"),
      {
        data: {
          interactionId: "budget_0",
          request: {
            kind: "budget",
            options: [{ id: "continue", label: "Continue" }],
            prompt: "More?",
          },
          subject: { turnId },
        },
        scope: { turnId },
        type: "interaction.opened",
      },
    ]);
    expect(tool(conversation)?.interaction).toMatchObject({
      interactionId: "approval_0",
      status: "open",
    });
    expect(
      assistantParts(conversation).flatMap((part) =>
        part.type === "interaction" ? [part.interactionId] : [],
      ),
    ).toEqual(["budget_0"]);
  });

  it("shows a relayed approval on the call that waits for it", () => {
    const conversation = observe([
      ...started,
      requested,
      approval("child:approval_0", {
        call: { callId: "child_call", name: "rm" },
        sessionId: "child",
        interactionId: "approval_0",
      }),
    ]);
    expect(tool(conversation)?.interaction).toMatchObject({
      call: { callId: "child_call", name: "rm" },
      interactionId: "child:approval_0",
    });
  });

  it("shows an answer this client sent as responded, until the stream refuses it", () => {
    const conversation = observe([...started, requested, approval("approval_0")]);
    conversation.answer([{ interactionId: "approval_0", optionId: "approve" }]);
    expect(conversation.state.interactions.approval_0?.status).toBe("responded");
    expect(tool(conversation)?.interaction?.status).toBe("responded");

    observe(
      [
        {
          data: {
            deliveryId: "d_1",
            interactionId: "approval_0",
            responseId: "response_0",
            value: { optionId: "approve" },
          },
          type: "response.submitted",
        },
        {
          data: { outcome: "refused", reason: "Wrong responder.", responseId: "response_0" },
          type: "response.settled",
        },
      ],
      conversation,
    );
    expect(conversation.state.interactions.approval_0).toMatchObject({ status: "open" });
    expect(conversation.state.interactions.approval_0?.answer).toBeUndefined();
  });

  it("keeps a settled turn's message while a later turn streams", () => {
    const conversation = observe([
      ...started,
      text("p_0", "Done."),
      { data: { outcome: "completed", runId }, scope, type: "model.settled" },
      {
        data: { outcome: "completed", reply: [], turnId },
        scope: { turnId },
        type: "turn.settled",
      },
    ]);
    const settled = conversation.state.messages[1];
    observe(
      [
        { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
        {
          data: { cause: { deliveryId: "d_1" }, follows: turnId, turnId: "turn_1" },
          scope: { turnId: "turn_1" },
          type: "turn.started",
        },
        {
          data: { owner: { turnId: "turn_1" }, runId: "run_1" },
          scope: { runId: "run_1", turnId: "turn_1" },
          type: "model.requested",
        },
      ],
      conversation,
    );
    expect(conversation.state.messages[1]).toBe(settled);
    expect(conversation.state.messages.at(-1)?.metadata).toMatchObject({
      status: "streaming",
      turnId: "turn_1",
    });
  });

  it("reads a complete stream at once", () => {
    const state = conversationOf(
      [...started, text("p_0", "Done.")].map((event, index) => stampTestEvent(event, index)),
    );
    expect(state.activeTurnId).toBe(turnId);
    expect(state.messages).toHaveLength(2);
  });
});
