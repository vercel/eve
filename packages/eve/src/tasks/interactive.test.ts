import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  DelegatedSessionKey,
  ModeKey,
  ScheduleIdKey,
  SessionCallbackKey,
  TurnScheduleIdKey,
} from "#context/keys.js";
import { isInteractiveRootSession, showsHeldTurnBoundary } from "#tasks/interactive.js";

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

describe("showsHeldTurnBoundary", () => {
  it("shows the waiting boundary only for an interactive root turn a schedule did not start", () => {
    expect(showsHeldTurnBoundary(context(), 0)).toBe(true);
    expect(
      showsHeldTurnBoundary(
        context((ctx) => ctx.set(ModeKey, "task")),
        0,
      ),
    ).toBe(false);
    expect(
      showsHeldTurnBoundary(
        context((ctx) => ctx.set(DelegatedSessionKey, true)),
        3,
      ),
    ).toBe(false);
    expect(
      showsHeldTurnBoundary(
        context((ctx) => ctx.set(TurnScheduleIdKey, "digest")),
        3,
      ),
    ).toBe(false);
    expect(showsHeldTurnBoundary(undefined, 0)).toBe(false);
  });

  it("treats only the first turn of a schedule-created session as scheduled", () => {
    const created = context((ctx) => ctx.set(ScheduleIdKey, "digest"));
    expect(showsHeldTurnBoundary(created, 0)).toBe(false);
    expect(showsHeldTurnBoundary(created, 1)).toBe(true);
  });
});
