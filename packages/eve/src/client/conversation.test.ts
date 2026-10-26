import { describe, expect, it } from "vitest";

import { call, interaction, turn } from "#protocol/session-projection/public-view.js";
import { Conversation, conversationOf } from "#client/conversation.js";
import type { EveMessagePart, EveToolPart } from "#client/message-types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { InteractionOrigin } from "#protocol/session-events/families/interaction.js";
import { stampTestEvent } from "#internal/testing/events.js";
import { eventsOfLine, linesOf } from "#protocol/session-lines.js";

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
  it("retains a structured result when a trailing person message has no assistant content", () => {
    const conversation = observe([
      ...started,
      text("p_0", "Done."),
      {
        type: "content.completed",
        data: {
          kind: "result",
          phase: "reply",
          partId: "result_0",
          runId,
          value: { deployed: true },
        },
      },
      { type: "delivery.admitted", data: { deliveryId: "d_1" } },
      {
        type: "delivery.consumed",
        data: { deliveryId: "d_1", turnId, parts: [{ kind: "text", text: "Thanks." }] },
      },
      { type: "model.settled", data: { runId, outcome: "completed" } },
      { type: "turn.settled", data: { turnId, outcome: "completed" } },
    ]);
    const assistants = conversation.state.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.metadata?.result).toEqual({ deployed: true });
  });

  it("exposes a committed line together, retaining the preceding snapshot", () => {
    const conversation = observe(started);
    const before = conversation.state;
    const at = "2026-10-10T00:00:00.000Z";
    const events = eventsOfLine(
      linesOf([requested, approval("i_0")], at)[0]!,
      conversation.view.position,
      at,
    );
    conversation.observe(events[0]!);
    expect(call(conversation.state.view, "call_0")).toBeUndefined();
    conversation.observe(events[1]!);
    expect(call(conversation.state.view, "call_0")?.state).toBe("approval");
    expect(interaction(conversation.state.view, "i_0")?.status).toBe("open");
    expect(call(before.view, "call_0")).toBeUndefined();
  });

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
      {
        data: { callId: "call_0", delta: '{"env"', kind: "tool", name: "deploy" },
        scope,
        type: "call.input",
      },
    ]);
    expect(assistantParts(conversation)).toMatchObject([
      { state: "streaming", text: "Check", type: "text" },
      { inputText: '{"env"', kind: "tool", name: "deploy", state: "streaming", type: "tool" },
    ]);

    observe([text("p_0", "Checking."), requested], conversation);
    expect(assistantParts(conversation)).toMatchObject([
      { state: "done", text: "Checking." },
      { input: { env: "prod" }, kind: "tool", label: "Deploying", state: "requested" },
    ]);
    expect(tool(conversation)?.inputText).toBeUndefined();
  });

  it("reads a call's part from its row: state, output, and label", () => {
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
      state: "running",
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
      output: { done: 2 },
      state: "completed",
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

  it.each(["receipt-first", "stream-first"])(
    "hands optimistic answers to the view (%s), then reopens a refused answer",
    (order) => {
      const conversation = observe([...started, requested, approval("approval_0")]);
      const pending = conversation.answer([{ interactionId: "approval_0", optionId: "approve" }]);
      expect(tool(conversation)?.interaction).toMatchObject({
        status: "open",
        answer: { optionId: "approve" },
      });
      if (order === "receipt-first") pending.accept("d_1");
      const at = "2026-10-15T00:00:00Z";
      for (const event of eventsOfLine(
        {
          at,
          facts: [
            { type: "delivery.admitted", data: { deliveryId: "d_1" } },
            {
              type: "response.submitted",
              data: {
                deliveryId: "d_1",
                interactionId: "approval_0",
                responseId: "response_0",
                value: { optionId: "approve" },
              },
            },
          ],
        },
        conversation.view.position,
        at,
      ))
        conversation.observe(event);
      if (order === "stream-first") pending.accept("d_1");
      expect(tool(conversation)?.interaction).toMatchObject({
        status: "open",
        answer: { optionId: "approve" },
      });
      observe(
        [
          {
            type: "response.settled",
            data: { outcome: "refused", reason: "Wrong responder.", responseId: "response_0" },
          },
        ],
        conversation,
      );
      expect(tool(conversation)?.interaction?.status).toBe("open");
      expect(tool(conversation)?.interaction?.answer).toBeUndefined();
    },
  );

  it("reconciles a split answer while its interaction is still open and the message waits", () => {
    const conversation = observe([...started, requested, approval("approval_0")]);
    const pending = conversation.answer([{ interactionId: "approval_0", optionId: "approve" }]);
    conversation.setSubmissions([{ id: "bob", message: "Bob follows up." }]);
    pending.accept("d_1");
    expect(tool(conversation)?.interaction?.answer).toMatchObject({ optionId: "approve" });

    observe([{ type: "delivery.admitted", data: { deliveryId: "answers_d_1" } }], conversation);
    expect(tool(conversation)?.interaction?.status).toBe("open");
    expect(tool(conversation)?.interaction?.answer).toBeUndefined();
    expect(
      conversation.state.messages.some((message) =>
        message.parts.some((part) => part.type === "text" && part.text === "Bob follows up."),
      ),
    ).toBe(true);

    observe(
      [
        { type: "delivery.consumed", data: { deliveryId: "answers_d_1", turnId, parts: [] } },
        {
          type: "response.submitted",
          data: {
            deliveryId: "answers_d_1",
            interactionId: "approval_0",
            responseId: "response_1",
            value: { optionId: "approve" },
          },
        },
        { type: "response.admitted", data: { responseId: "response_1" } },
      ],
      conversation,
    );
    expect(tool(conversation)?.interaction?.answer).toMatchObject({ optionId: "approve" });
    expect(conversation.view.deliveries["d_1"]).toBeUndefined();
  });

  it("does not retract a newer answer when an earlier POST fails", () => {
    const conversation = observe([...started, requested, approval("approval_0")]);
    const retract = conversation.answer([{ interactionId: "approval_0", optionId: "approve" }]);
    conversation.answer([{ interactionId: "approval_0", optionId: "deny" }]);
    retract();
    expect(tool(conversation)?.interaction?.answer).toEqual({
      interactionId: "approval_0",
      optionId: "deny",
    });
  });

  it("shows an admitted answer from another client while its prompt stays open", () => {
    // Another tab, or this one before a reload, approved; the batch still waits on the rest.
    const conversation = observe([
      ...started,
      requested,
      approval("approval_0"),
      {
        data: {
          deliveryId: "d_1",
          interactionId: "approval_0",
          responseId: "response_0",
          value: { optionId: "approve" },
        },
        type: "response.submitted",
      },
      { data: { responseId: "response_0" }, type: "response.admitted" },
    ]);
    expect(tool(conversation)?.interaction).toMatchObject({
      answer: { interactionId: "approval_0", optionId: "approve" },
      status: "open",
    });
    expect(tool(conversation)?.interaction?.status).toBe("open");
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

  it("shows a message sent while the turn works where the turn took it in", () => {
    const conversation = observe([
      ...started,
      requested,
      { data: { callId: "call_0", outcome: "completed" }, scope, type: "call.settled" },
    ]);
    const before = conversation.state.messages[1];
    // Until eve consumes it, the message shows where it was sent: after what the turn has done.
    conversation.setSubmissions([{ id: "s_0", message: "Use staging.", turnId }]);
    const echoId = conversation.state.messages.at(-1)?.id;
    const shown = () =>
      conversation.state.messages.map(
        (message) =>
          `${message.role}: ${message.parts
            .map((part) =>
              part.type === "text" ? part.text : part.type === "tool" ? part.callId : part.type,
            )
            .join(", ")}`,
      );
    expect(shown()).toEqual(["user: Deploy it.", "assistant: call_0", "user: Use staging."]);

    conversation.confirmSubmission("s_0", "d_1");
    conversation.setSubmissions([]);
    observe(
      [
        { data: { outcome: "completed", runId }, scope, type: "model.settled" },
        { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
        {
          data: { deliveryId: "d_1", parts: [{ kind: "text", text: "Use staging." }], turnId },
          scope: { turnId },
          type: "delivery.consumed",
        },
        { data: { owner: { turnId }, runId: "run_1" }, scope, type: "model.requested" },
      ],
      conversation,
    );
    // The turn goes on below the message, and what it did before keeps its place and identity.
    expect(shown()).toEqual([
      "user: Deploy it.",
      "assistant: call_0",
      "user: Use staging.",
      "assistant: ",
    ]);
    expect(conversation.state.messages[1]?.id).toBe(before?.id);
    expect(conversation.state.messages[2]?.id).toBe(echoId);
    expect(conversation.state.messages.at(-1)?.metadata?.status).toBe("streaming");

    observe(
      [
        {
          data: { kind: "text", partId: "p_1", phase: "reply", runId: "run_1", value: "Done." },
          scope: { runId: "run_1", turnId },
          type: "content.completed",
        },
      ],
      conversation,
    );
    expect(shown()).toEqual([
      "user: Deploy it.",
      "assistant: call_0",
      "user: Use staging.",
      "assistant: Done.",
    ]);
  });

  it("reads a complete stream at once", () => {
    const state = conversationOf(
      [...started, text("p_0", "Done.")].map((event, index) => stampTestEvent(event, index)),
    );
    expect(turn(state.view, turnId)?.status).toBe("running");
    expect(state.messages).toHaveLength(2);
  });
  it("shows imported history before what its line's deliveries sent, apart from the reply", () => {
    const line = (at: number, events: readonly SessionEvent[]) =>
      events.map((event, index) => ({
        ...event,
        meta: {
          at: new Date(Date.UTC(2026, 0, 1) + at).toISOString(),
          endOfLine: index === events.length - 1,
          position: { index, line: at },
        },
      }));
    const consumed = (
      deliveryId: string,
      history: readonly {
        readonly id?: string;
        readonly role: "user" | "assistant";
        readonly text: string;
      }[],
      message: string,
    ): SessionEvent => ({
      data: { deliveryId, history, parts: [{ kind: "text", text: message }], turnId },
      scope: { turnId },
      type: "delivery.consumed",
    });
    const conversation = new Conversation();
    for (const event of [
      ...line(0, [
        { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
        { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
      ]),
      ...line(1, [
        {
          data: { cause: { deliveryId: "d_0" }, follows: null, turnId },
          scope: { turnId },
          type: "turn.started",
        },
        consumed(
          "d_0",
          [
            { id: "app-1", role: "user", text: "Earlier question" },
            { role: "assistant", text: "Earlier answer" },
          ],
          "Deploy it.",
        ),
        consumed("d_1", [{ role: "user", text: "Bob's note" }], "Use staging."),
        { data: { owner: { turnId }, runId }, scope, type: "model.requested" },
      ]),
      ...line(2, [text("p_0", "Done.")]),
    ])
      conversation.observe(event);

    const { messages } = conversation.state;
    expect(
      messages.map(
        (message) =>
          `${message.role}: ${message.parts.map((part) => ("text" in part ? part.text : part.type)).join("")}`,
      ),
    ).toEqual([
      "user: Earlier question",
      "assistant: Earlier answer",
      "user: Bob's note",
      "user: Deploy it.",
      "user: Use staging.",
      "assistant: Done.",
    ]);
    // Imported messages name no turn, so the turn's reply never streams into one.
    expect(messages[0]?.metadata).toEqual({
      historyId: "app-1",
      imported: true,
      status: "complete",
    });
    expect(messages[1]?.metadata).toEqual({ imported: true, status: "complete" });
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
    // The delivery's row keeps no copy of the history its fact carried.
    expect(conversation.view.deliveries.d_0).not.toHaveProperty("history");
  });
});
