import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { DelegatedSessionKey, ModeKey, SessionCallbackKey } from "#context/keys.js";
import { isInteractiveRootSession } from "#tasks/interactive.js";

function context(configure: (ctx: ContextContainer) => void = () => {}): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(ModeKey, "conversation");
  configure(ctx);
  return ctx;
}

describe("isInteractiveRootSession", () => {
  it("holds for a root conversation session and excludes task mode and delegated sessions", () => {
    expect(isInteractiveRootSession(context())).toBe(true);
    expect(isInteractiveRootSession(context((ctx) => ctx.set(ModeKey, "task")))).toBe(false);
    expect(isInteractiveRootSession(context((ctx) => ctx.set(DelegatedSessionKey, true)))).toBe(
      false,
    );
  });

  it("does not change when a later turn of a root session binds a caller callback", () => {
    const ctx = context((next) =>
      next.set(SessionCallbackKey, { callId: "call-1", url: "https://caller.example" } as never),
    );
    expect(isInteractiveRootSession(ctx)).toBe(true);
  });
});
