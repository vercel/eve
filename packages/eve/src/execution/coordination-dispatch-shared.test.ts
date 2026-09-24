import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ModeKey, ParentSessionKey, ScheduleIdKey, SessionCallbackKey } from "#context/keys.js";
import { isInteractiveRootTurn } from "#execution/coordination-dispatch-shared.js";

function context(configure: (ctx: ContextContainer) => void = () => {}): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(ModeKey, "conversation");
  configure(ctx);
  return ctx;
}

describe("isInteractiveRootTurn", () => {
  it("holds for a root conversation session", () => {
    expect(isInteractiveRootTurn(context(), 0)).toBe(true);
  });

  it("excludes task mode, child sessions, and remotely called sessions", () => {
    expect(
      isInteractiveRootTurn(
        context((ctx) => ctx.set(ModeKey, "task")),
        2,
      ),
    ).toBe(false);
    expect(
      isInteractiveRootTurn(
        context((ctx) =>
          ctx.set(ParentSessionKey, { callId: "call-1", sessionId: "parent" } as never),
        ),
        2,
      ),
    ).toBe(false);
    expect(
      isInteractiveRootTurn(
        context((ctx) => ctx.set(SessionCallbackKey, { url: "https://caller.example" } as never)),
        2,
      ),
    ).toBe(false);
  });

  it("excludes the turn a schedule started, but not later turns in its session", () => {
    const scheduled = context((ctx) => ctx.set(ScheduleIdKey, "daily-report"));
    expect(isInteractiveRootTurn(scheduled, 0)).toBe(false);
    expect(isInteractiveRootTurn(scheduled, 1)).toBe(true);
  });
});
