import { describe, expect, it, vi } from "vitest";

import {
  buildCallbackContext,
  withRuntimeSandboxLifecycle,
} from "#context/build-callback-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { ConversationContextKey, type ConversationContext } from "#shared/conversation-context.js";

describe("buildCallbackContext", () => {
  function contextWith(conversation?: ConversationContext): ContextContainer {
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null, sender: null },
      sessionId: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    });
    if (conversation !== undefined) ctx.set(ConversationContextKey, conversation);
    return ctx;
  }

  it("exposes the session's conversation, including its space", () => {
    const conversation: ConversationContext = {
      audience: "private",
      channel: { kind: "channel:slack", name: "slack" },
      environment: "production",
      principalType: "user",
      space: { id: "slack:T1:C1", type: "shared", workspaceId: "slack:T1" },
    };

    expect(
      contextStorage.run(contextWith(conversation), buildCallbackContext).conversation,
    ).toEqual(conversation);
  });

  it("omits the conversation when the session has none", () => {
    expect(contextStorage.run(contextWith(), buildCallbackContext)).not.toHaveProperty(
      "conversation",
    );
  });
});

describe("withRuntimeSandboxLifecycle", () => {
  it("preserves custom methods and private receivers on frozen provider sessions", async () => {
    class CustomSession {
      readonly #token = "custom-session-ok";
      probe() {
        return this.#token;
      }
    }
    const target = Object.freeze(new CustomSession());
    const deleteSandbox = vi.fn(async () => {});
    const stop = vi.fn(async () => {});

    const session = withRuntimeSandboxLifecycle(
      target as never,
      deleteSandbox,
      stop,
    ) as CustomSession & {
      delete(): Promise<void>;
      stop(): Promise<void>;
    };

    expect(session.probe()).toBe("custom-session-ok");
    await session.delete();
    await session.stop();
    expect(deleteSandbox).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
