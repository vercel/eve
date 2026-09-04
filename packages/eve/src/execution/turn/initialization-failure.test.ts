import { beforeEach, describe, expect, it, vi } from "vitest";

import { notifyInitializationFailure } from "#execution/turn/initialization-failure.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { createSessionFailedEvent, stampMessageStreamEvent } from "#protocol/message.js";

const deserialize = vi.hoisted(() => vi.fn());
vi.mock("#context/serialize.js", () => ({ deserializeContext: deserialize }));
vi.mock("#internal/logging.js", () => ({ createLogger: () => ({ error: vi.fn() }) }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("initialization failure notification", () => {
  it("notifies the channel using the generic committed event without constructing a harness session", async () => {
    const failed = vi.fn();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, "session");
    ctx.set(ChannelKey, { kind: "slack", "session.failed": failed });
    deserialize.mockResolvedValue(ctx);
    const event = stampMessageStreamEvent(
      createSessionFailedEvent({
        code: "SESSION_INITIALIZATION_FAILED",
        message: "The session could not initialize.",
        sessionId: "session",
      }),
    );
    await notifyInitializationFailure({ serializedContext: {}, event });
    expect(failed).toHaveBeenCalledWith(
      {
        code: "SESSION_INITIALIZATION_FAILED",
        message: "The session could not initialize.",
        sessionId: "session",
      },
      expect.anything(),
    );
  });

  it("keeps an unavailable adapter or context from replacing the original failure", async () => {
    deserialize.mockRejectedValueOnce(new Error("Missing deployment"));
    const event = stampMessageStreamEvent(
      createSessionFailedEvent({
        code: "SESSION_INITIALIZATION_FAILED",
        message: "The session could not initialize.",
        sessionId: "session",
      }),
    );
    await expect(
      notifyInitializationFailure({ serializedContext: {}, event }),
    ).resolves.toBeUndefined();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, "session");
    ctx.set(ChannelKey, {
      kind: "slack",
      "session.failed": () => {
        throw new Error("Slack unavailable");
      },
    });
    deserialize.mockResolvedValue(ctx);
    await expect(
      notifyInitializationFailure({ serializedContext: {}, event }),
    ).resolves.toBeUndefined();
  });
});
