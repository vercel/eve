import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { emitTerminalSessionEvent } from "#execution/terminal-session-event.js";
import { createSessionCompletedEvent } from "#protocol/message.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const deserializeContext = vi.hoisted(() => vi.fn());

vi.mock("#context/serialize.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#context/serialize.js")>()),
  deserializeContext,
}));

describe("emitTerminalSessionEvent", () => {
  beforeEach(() => {
    const ctx = new ContextContainer();
    ctx.set(BundleKey, { turnAgent: { id: "test-agent" } } as never);
    deserializeContext.mockResolvedValue(ctx);
  });

  it("closes the durable stream after the terminal event", async () => {
    const close = vi.fn();
    const parentWritable = new WritableStream<Uint8Array>({
      close,
      write() {},
    });

    await emitTerminalSessionEvent({
      event: createSessionCompletedEvent(),
      parentWritable,
      serializedContext: {},
    });

    expect(close).toHaveBeenCalledOnce();
  });
});
