import { beforeEach, expect, it, vi } from "vitest";

vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(),
}));
vi.mock("#context/hook-lifecycle.js", () => ({
  dispatchStreamEventHooks: vi.fn(),
}));

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { ContextContainer } from "#context/container.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { SessionIdKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { finalizeSession } from "#execution/session/finalization.js";
import { setHarnessEmissionState } from "#harness/emission-state.js";
import { POST, defineChannel } from "#public/definitions/channel.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const SESSION_ID = "session-expired";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EVE_LOG_LEVEL", "silent");
  return () => vi.unstubAllEnvs();
});

// Expiry, reset, and a closed inbox all end the session outside a turn, where
// no turn step has installed the session callback context.
it("delivers session.completed to the channel handler when a session expires between turns", async () => {
  const handler = vi.fn();
  const channel = defineChannel({
    events: { "session.completed": handler },
    routes: [POST("/test", async () => new Response("ok"))],
  });
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");

  const restored = new ContextContainer();
  restored.set(BundleKey, { hookRegistry: {}, turnAgent: { id: "test-agent" } } as any);
  restored.set(ChannelKey, channel.adapter);
  restored.set(SessionIdKey, SESSION_ID);
  vi.mocked(deserializeContext).mockResolvedValue(restored);

  // `turn_3` completed: its epilogue cleared the turn id and advanced the sequence to 4.
  const session = setHarnessEmissionState(
    {
      agent: { modelReference: { id: "unused" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "token",
      history: [],
      sessionId: SESSION_ID,
    },
    { sessionStarted: true, sequence: 4, stepIndex: 0, turnId: "" },
  );

  const written: string[] = [];
  await finalizeSession(
    { kind: "expired" },
    {
      caller: undefined,
      cursor: {
        serializedContext: { "eve.sessionId": SESSION_ID },
        sessionState: createDurableSessionState({ session }),
      },
      sessionWritable: new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(new TextDecoder().decode(chunk));
        },
      }),
    },
  );

  expect(written.join("")).toContain('"type":"session.completed"');
  expect(handler).toHaveBeenCalledOnce();
  expect(handler.mock.calls[0]?.[2]?.session).toMatchObject({
    id: SESSION_ID,
    turn: { id: "turn_3", sequence: 3 },
  });
  // Terminal delivery runs no stream-event hooks, by design.
  expect(dispatchStreamEventHooks).not.toHaveBeenCalled();
});
