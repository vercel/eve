import { describe, expect, it, vi } from "vitest";

vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(),
}));

vi.mock("#context/hook-lifecycle.js", () => ({
  dispatchStreamEventHooks: vi.fn(),
}));

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import { emitTerminalSessionEvent } from "#execution/terminal-session-event.js";
import { POST, defineChannel } from "#public/definitions/channel.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";

describe("emitTerminalSessionEvent", () => {
  it("dispatches authored session.completed handlers for out-of-turn completion", async () => {
    vi.stubEnv("EVE_LOG_LEVEL", "error");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const channelHandler = vi.fn();
    const channel = defineChannel({
      events: {
        "session.completed": channelHandler,
      },
      routes: [POST("/test", async () => new Response("ok"))],
    });
    if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");

    const restored = new ContextContainer();
    restored.set(BundleKey, {
      hookRegistry: {},
      turnAgent: { id: "test-agent" },
    } as any);
    restored.set(ChannelKey, channel.adapter);
    restored.set(SessionIdKey, "session-terminal-test");
    vi.mocked(deserializeContext).mockResolvedValue(restored);

    const chunks: Uint8Array[] = [];
    const parentWritable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    await emitTerminalSessionEvent({
      event: { type: "session.completed" },
      parentWritable,
      serializedContext: { "eve.sessionId": "session-terminal-test" },
    });

    const stream = new TextDecoder().decode(chunks[0]);
    const errors = errorSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

    expect(stream).toContain('"type":"session.completed"');
    expect(channelHandler).toHaveBeenCalledOnce();
    expect(channelHandler.mock.calls[0]?.[2]?.session.id).toBe("session-terminal-test");
    expect(dispatchStreamEventHooks).toHaveBeenCalledOnce();
    expect(errors).not.toContain("adapter event handler threw — event swallowed");

    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});
