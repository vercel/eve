import { describe, expect, it, vi } from "vitest";

import { CHANNEL_SENTINEL, type CompiledChannel } from "#channel/compiled-channel.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ParentSessionKey, SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { hasDelegatedCaller } from "#execution/session/delegated-caller.js";
import { createToolChannelTo } from "#execution/tools/channel-to.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

function inbox() {
  const receive = vi.fn(async (_input: unknown) => ({ id: "session_inbox" }) as never);
  const definition: CompiledChannel = {
    __kind: CHANNEL_SENTINEL,
    routes: [{ method: "POST", path: "/inbox", handler: async () => new Response("ok") }],
    adapter: { kind: "channel:inbox" },
    receive,
  };
  // Only the fields ctx.to() reads.
  const bundle: CompiledRuntimeAgentBundle = {
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    graph: {
      root: {
        channels: [{ name: "inbox", definition, receive, adapter: definition.adapter }],
      },
    },
  } as never;
  return { bundle, definition, receive };
}

describe("createToolChannelTo", () => {
  it("refuses a delegated session before loading the agent", () => {
    const { definition } = inbox();
    const loadBundle = vi.fn();
    const to = createToolChannelTo({
      delegated: true,
      loadBundle,
    });

    expect(() => to(definition, {})).toThrow("ctx.to() isn't available in a delegated session");
    expect(loadBundle).not.toHaveBeenCalled();
  });

  it("runs receive() outside the tool's session context", async () => {
    const { bundle, definition, receive } = inbox();
    let receiveSessionId: string | undefined = "unset";
    receive.mockImplementationOnce(async () => {
      receiveSessionId = contextStorage.getStore()?.get(SessionIdKey);
      return { id: "session_inbox" } as never;
    });
    const to = createToolChannelTo({
      delegated: false,
      loadBundle: () => bundle,
    });
    const toolContext = new ContextContainer();
    toolContext.set(SessionIdKey, "session_alice");

    await contextStorage.run(toolContext, () =>
      to(definition, { ref: 1 }).send("Alice asked for the report.", { auth: null }),
    );

    expect(receive).toHaveBeenCalledOnce();
    expect(receiveSessionId).toBeUndefined();
  });
});

describe("hasDelegatedCaller", () => {
  it.each([
    [
      "a local subagent or root copy",
      ParentSessionKey,
      { callId: "call_1", rootSessionId: "r", sessionId: "r", turn: { id: "t", sequence: 1 } },
    ],
    [
      "a remote agent call",
      SessionCallbackKey,
      { callId: "call_1", token: "token", url: "https://caller.example/callback" },
    ],
  ] as const)("is true in %s", (_name, key, value) => {
    const ctx = new ContextContainer();
    ctx.set(key as typeof ParentSessionKey, value as never);
    expect(hasDelegatedCaller(ctx)).toBe(true);
  });

  it("is false in a root session", () => {
    expect(hasDelegatedCaller(new ContextContainer())).toBe(false);
  });
});
