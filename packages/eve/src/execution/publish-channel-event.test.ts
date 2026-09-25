import { describe, expect, it } from "vitest";
import { ContextContainer } from "#context/container.js";
import { ActivityRootTurnIdKey, TurnDeliveryFailedKey } from "#context/keys.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { writeChannelEvent } from "#execution/publish-channel-event.js";
import type { MessageStreamEvent, UnstampedMessageStreamEvent } from "#protocol/message.js";

const completed = {
  type: "turn.completed",
  data: { turnId: "A", sequence: 0 },
} as UnstampedMessageStreamEvent;

describe("durable request completion", () => {
  it("waits for channel delivery before stamping or writing the terminal boundary", async () => {
    const ctx = new ContextContainer();
    ctx.set(ActivityRootTurnIdKey, "A");
    let release!: () => void;
    const delivered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: ChannelAdapter = { kind: "test", "turn.completed": () => delivered };
    const written: MessageStreamEvent[] = [];
    const writer = new WritableStream<Uint8Array>({
      write(bytes) {
        written.push(JSON.parse(new TextDecoder().decode(bytes)));
      },
    }).getWriter();
    const pending = writeChannelEvent({
      adapter,
      adapterCtx: buildAdapterContext(adapter, ctx),
      ctx,
      event: completed,
      writer,
    });
    expect(written).toEqual([]);
    release();
    const result = await pending;
    expect(result.meta.request).toEqual({ id: "A", phase: "none", outcome: "completed" });
    expect(written).toEqual([result]);
    writer.releaseLock();
  });

  it("retains a channel failure across step restoration and never claims delivery succeeded", async () => {
    const ctx = new ContextContainer();
    ctx.set(ActivityRootTurnIdKey, "A");
    const adapter: ChannelAdapter = {
      kind: "test",
      "message.completed": async () => {
        throw new Error("delivery unavailable");
      },
    };
    const writer = new WritableStream<Uint8Array>().getWriter();
    const message = await writeChannelEvent({
      adapter,
      adapterCtx: buildAdapterContext(adapter, ctx),
      ctx,
      event: {
        type: "message.completed",
        data: {
          message: "Undelivered",
          turnId: "A",
          sequence: 0,
          stepIndex: 0,
          finishReason: "stop",
        },
      },
      writer,
    });
    expect(message.meta.request?.delivered).toBe(false);
    const restored = new ContextContainer();
    for (const [key, value] of ctx.entries()) restored.set(key, value);
    expect(restored.get(TurnDeliveryFailedKey)).toBe(true);
    const terminal = await writeChannelEvent({
      adapter,
      adapterCtx: buildAdapterContext(adapter, restored),
      ctx: restored,
      event: completed,
      writer,
    });
    expect(terminal.meta.request?.outcome).toBe("failed");
    writer.releaseLock();
  });
});
