import { describe, expect, it } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import type { CompiledChannel } from "#channel/compiled-channel.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import { attachInputText, readInputText } from "#internal/input-text.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import { turn } from "#protocol/session-projection/public-view.js";
import { defineChannel, type ChannelEventContext } from "#public/definitions/channel.js";

function adapterOf(channel: unknown): ChannelAdapter<any> {
  return (channel as CompiledChannel<any, any, any>).adapter;
}

function sessionContext(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session_1",
    turn: { id: "turn_0", sequence: 0 },
  });
  enterSessionProjection(ctx, undefined);
  return ctx;
}

const SETTLED: SessionEvent = {
  data: { outcome: "completed", turnId: "turn_0" },
  scope: { turnId: "turn_0" },
  type: "turn.settled",
} as SessionEvent;

describe("defineChannel delivery", () => {
  it.each([false, true])("preserves input when a %s async hook returns void", async (asyncHook) => {
    const merge = (
      payload: import("#shared/channel-delivery.js").ChannelDelivery<{ count: number }>,
      channel: { state: { count: number } },
    ) => {
      channel.state.count += payload.state?.count ?? 0;
    };
    const channel = defineChannel<{ count: number }, { state: { count: number } }>({
      state: { count: 0 },
      context: (state) => ({ state }),
      deliver: asyncHook ? async (payload, channel) => merge(payload, channel) : merge,
      routes: [],
    });
    const adapter = adapterOf(channel);
    const ctx = sessionContext();
    const adapterCtx = buildAdapterContext(adapter, ctx);
    const payload = attachClientContext(
      attachInputText(
        {
          message: "A wrapped message",
          answers: [{ interactionId: "question_1", text: "yes" }],
          context: ["Saved context"],
          outputSchema: { type: "object" },
          state: { count: 2 },
        },
        "yes",
      ),
      ["Turn-only context"],
    );
    const result = await adapter.deliver!(payload, adapterCtx);
    expect(result).toMatchObject({
      message: payload.message,
      answers: payload.answers,
      context: payload.context,
      outputSchema: payload.outputSchema,
    });
    expect(adapterCtx.state.count).toBe(2);
    expect(readInputText(result ?? undefined)).toBe("yes");
    expect(readClientContext(result ?? undefined)).toEqual(["Turn-only context"]);
  });

  it("ignores an empty replacement even when the input has private context", async () => {
    const adapter = adapterOf(defineChannel({ routes: [], deliver: () => ({}) }));
    const payload = attachClientContext(attachInputText({ message: "Alice's notes" }, "yes"), [
      "Turn-only context",
    ]);
    expect(
      await adapter.deliver!(payload, buildAdapterContext(adapter, sessionContext())),
    ).toBeUndefined();
  });

  it("runs a deliver-only channel and preserves private context on a replacement", async () => {
    const adapter = adapterOf(
      defineChannel({
        routes: [],
        deliver: () => ({ message: "Transformed message" }),
      }),
    );
    const payload = attachClientContext(attachInputText({ message: "Original message" }, "yes"), [
      "Turn-only context",
    ]);
    const result = await adapter.deliver!(payload, buildAdapterContext(adapter, sessionContext()));
    expect(result?.message).toBe("Transformed message");
    expect(readInputText(result ?? undefined)).toBe("yes");
    expect(readClientContext(result ?? undefined)).toEqual(["Turn-only context"]);
  });
});

describe("defineChannel events", () => {
  it("hands a handler the event and a context holding the channel's own context", async () => {
    const seen: { event?: unknown; ctx?: ChannelEventContext<{ label: string }> } = {};
    const channel = defineChannel<{ count: number }, { label: string }>({
      context: () => ({ label: "thread" }),
      events: {
        "turn.settled"(event, ctx) {
          seen.event = event;
          seen.ctx = ctx;
        },
      },
      routes: [],
      state: { count: 0 },
    });
    const adapter = adapterOf(channel);
    const ctx = sessionContext();
    const view = emptySessionView();
    foldLine(
      view,
      {
        at: "2026-10-19T00:00:00.000Z",
        facts: [
          {
            type: "turn.started",
            data: { turnId: "turn_0", cause: { deliveryId: "d" }, follows: null },
          },
          SETTLED,
        ],
      },
      3,
    );
    await contextStorage.run(ctx, () =>
      callAdapterEventHandler(adapter, SETTLED, {
        ...buildAdapterContext(adapter, ctx),
        position: { index: 0, line: 3 },
        view,
      }),
    );

    expect(seen.event).toBe(SETTLED);
    expect(seen.ctx?.channel.label).toBe("thread");
    expect(seen.ctx?.position).toEqual({ index: 0, line: 3 });
    expect(seen.ctx?.view).not.toHaveProperty("turns");
    expect(turn(seen.ctx!.view, "turn_0")?.outcome).toBe("completed");
    expect(seen.ctx?.session.id).toBe("session_1");
    expect(seen.ctx).not.toHaveProperty("scope");
  });

  it("lets a handler keep state on its channel context across events", async () => {
    const channel = defineChannel<{ count: number }, { state: { count: number } }>({
      context: (state) => ({ state }),
      events: {
        "turn.settled"(_event, { channel }) {
          channel.state.count += 1;
        },
      },
      routes: [],
      state: { count: 0 },
    });
    const adapter = adapterOf(channel);
    const ctx = sessionContext();
    const adapterCtx = buildAdapterContext(adapter, ctx);
    await contextStorage.run(ctx, async () => {
      await callAdapterEventHandler(adapter, SETTLED, adapterCtx);
      await callAdapterEventHandler(adapter, SETTLED, adapterCtx);
    });

    expect(adapterCtx.state).toEqual({ count: 2 });
  });
});
