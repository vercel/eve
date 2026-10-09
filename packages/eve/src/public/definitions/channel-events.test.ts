import { describe, expect, it } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import type { CompiledChannel } from "#channel/compiled-channel.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
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
    expect(seen.ctx?.view).toBe(view);
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
