import { jsonSchema } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { currentView, enterSessionProjection } from "#harness/session-machine/current.js";
import { createTestKernel } from "#internal/testing/kernel.js";
import { foldingHandler, withOpenTurn } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { ToolReplyPartDefinition } from "#tools/definition.js";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

const spec = { root: "summary" };

/** Alice asks for her week's numbers; the model draws a card, then answers in one sentence. */
async function runCardTurn(
  build: ToolReplyPartDefinition["build"],
  options: { readonly endsTurn?: boolean } = {},
) {
  const events: SessionEvent[] = [];
  const doStream = vi
    .fn<MockLanguageModelV4["doStream"]>()
    .mockResolvedValueOnce({
      stream: convertArrayToReadableStream([
        { id: "card-1", toolName: "card", type: "tool-input-start" },
        { delta: JSON.stringify(spec), id: "card-1", type: "tool-input-delta" },
        { id: "card-1", type: "tool-input-end" },
        { input: JSON.stringify(spec), toolCallId: "card-1", toolName: "card", type: "tool-call" },
        { finishReason: { raw: undefined, unified: "tool-calls" }, type: "finish", usage },
      ]),
    })
    .mockResolvedValueOnce({
      stream: convertArrayToReadableStream([
        { id: "t", type: "text-start" },
        { delta: "Deploys were up this week.", id: "t", type: "text-delta" },
        { id: "t", type: "text-end" },
        { finishReason: { raw: undefined, unified: "stop" }, type: "finish", usage },
      ]),
    });
  const step = createTestKernel({
    agent: { model: { id: "reply-test" } },
    handleEvent: foldingHandler((event) => {
      events.push(event);
    }),
    resolveModel: async () => new MockLanguageModelV4({ doStream }),
    tools: new Map([
      [
        "card",
        {
          description: "Show numbers as a card.",
          execute: async () => ({ shown: true }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "card",
          ...(options.endsTurn === true && { endsTurn: true }),
          replyPart: {
            build,
            kind: "card",
            mediaType: "application/vnd.test+json",
            streamInput: true,
          },
        },
      ],
    ]),
  });
  const ctx = new ContextContainer();
  const session = withOpenTurn(
    { compaction: {}, continuationToken: "http:reply-test", history: [], sessionId: "reply-test" },
    { sequence: 1, turnId: "reply-turn" },
  );
  enterSessionProjection(ctx, session.state);
  let result = await contextStorage.run(ctx, () =>
    step(session, { message: "How did my deploys go?" }),
  );
  for (let steps = 0; typeof result.next === "function" && steps < 5; steps += 1) {
    const next = result.next;
    const current = result.session;
    result = await contextStorage.run(ctx, () => next(current));
  }
  return {
    doStream,
    events,
    history: JSON.stringify(result.session.history),
    view: currentView(ctx),
  };
}

describe("tool reply parts", () => {
  it("previews the call's input as its reply part, then completes the part with the call", async () => {
    const { events, view } = await runCardTurn((input) => ({
      fallbackText: "Weekly summary card.",
      value: input,
    }));

    const previews = events.filter((event) => event.type === "content.delta");
    expect(previews[0]).toMatchObject({
      data: { callId: "card-1", kind: "card", partId: "card-1.reply" },
    });
    expect(events.some((event) => event.type === "call.input")).toBe(false);

    const types = events.map((event) => event.type);
    const completed = events.find(
      (event) => event.type === "content.completed" && event.data.callId === "card-1",
    );
    expect(completed).toEqual({
      data: {
        callId: "card-1",
        fallbackText: "Weekly summary card.",
        kind: "card",
        mediaType: "application/vnd.test+json",
        partId: "card-1.reply",
        phase: "reply",
        value: spec,
      },
      type: "content.completed",
    });
    expect(types.indexOf("call.settled")).toBe(types.indexOf("content.completed") + 1);
    // The turn owns the part, and the model's closing sentence adds to its reply.
    expect(view.parts["card-1.reply"]).toMatchObject({ turnId: "reply-turn" });
    expect(view.parts["card-1.reply"]?.runId).toBeUndefined();
    expect(view.turns["reply-turn"]?.reply).toEqual(["card-1.reply", expect.any(String)]);
  });

  it("ends the turn on the card alone when the tool ends the turn", async () => {
    const { doStream, events, view } = await runCardTurn(
      (input) => ({ fallbackText: "Weekly summary card.", value: input }),
      { endsTurn: true },
    );

    expect(doStream).toHaveBeenCalledOnce();
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { outcome: "completed" },
    });
    expect(view.turns["reply-turn"]?.reply).toEqual(["card-1.reply"]);
  });

  it("fails the call when its reply part throws, so the model reads why", async () => {
    const { events, history } = await runCardTurn(() => {
      throw new Error('Element "summary" is missing.');
    });

    expect(
      events.some((event) => event.type === "content.completed" && event.data.callId !== undefined),
    ).toBe(false);
    expect(events.find((event) => event.type === "call.settled")).toMatchObject({
      data: { callId: "card-1", outcome: "failed" },
    });
    expect(history).toContain('Element \\"summary\\" is missing.');
  });
});
