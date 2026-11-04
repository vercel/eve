import { expect, it, vi } from "vitest";
import * as events from "#public/events/index.js";
import { stampTestEvents } from "#internal/testing/events.js";
import type { SessionEvent } from "#protocol/session-event.js";

it("reads and folds snapshots produced by an independent module copy", async () => {
  const view = events.foldEvents(events.emptySessionView(), stampTestEvents(opening));
  vi.resetModules();
  const other = await import("#public/events/index.js");
  expect(other.call).not.toBe(events.call);
  expect(other.call(view, "c")).toMatchObject({ name: "lookup" });
  const copied = other.foldEvents(view, []);
  expect(events.calls(copied)).toEqual(other.calls(view));
});

const opening: SessionEvent[] = [
  { type: "session.started", data: {} },
  { type: "turn.started", data: { turnId: "turn_0", cause: { deliveryId: "d" }, follows: null } },
  { type: "model.requested", data: { runId: "r", owner: { turnId: "turn_0" } } },
  {
    type: "call.requested",
    data: {
      callId: "c",
      owner: { runId: "r" },
      capability: { kind: "tool", name: "lookup" },
      input: { nested: ["original"] },
    },
  },
];

it("keeps snapshots opaque and immutable through later folds and consumer mutations", () => {
  const initial = events.emptySessionView();
  expect(initial).not.toHaveProperty("calls");
  const observed = events.foldEvents(initial, stampTestEvents(opening));
  const call = events.call(observed, "c");
  expect(call).toMatchObject({
    name: "lookup",
    kind: "tool",
    state: "requested",
    turnId: "turn_0",
  });
  expect(events.call(initial, "c")).toBeUndefined();
  const input = call?.input;
  if (typeof input !== "object" || input === null) throw new Error("Missing call input.");
  expect(Reflect.set(input, "nested", [])).toBe(false);
  const ended = events.foldEvents(
    observed,
    stampTestEvents([
      ...opening,
      { type: "call.started", data: { callId: "c" } },
      {
        type: "call.settled",
        data: {
          callId: "c",
          outcome: "failed",
          error: { code: "LOOKUP_FAILED", message: "Try again." },
        },
      },
    ]),
  );
  expect(events.call(ended, "c")).toMatchObject({
    state: "failed",
    error: { code: "LOOKUP_FAILED" },
  });
  expect(events.call(observed, "c")).toEqual(call);
  expect(events.calls(ended, { kind: "agent" })).toEqual([]);
  expect(events.calls(ended, { turnId: "turn_0" })).toHaveLength(1);
});

it("publishes complete commits and retains partial lines across replay overlap", () => {
  const [first, last] = stampTestEvents(opening.slice(0, 2));
  const line = { ...first!, meta: { ...first!.meta, endOfLine: false } };
  const tail = {
    ...last!,
    meta: { ...line.meta, endOfLine: true, position: { line: 0, index: 1 } },
  };
  const future = {
    ...stampTestEvents([opening[2]!])[0]!,
    meta: { ...last!.meta, position: { line: 1, index: 0 } },
  };
  const pending = events.foldEvents(events.emptySessionView(), [line, future]);
  expect(events.session(pending).status).toBe("new");
  const committed = events.foldEvents(pending, [line, tail]);
  expect(events.session(committed).status).toBe("open");
  expect(events.turns(committed)).toHaveLength(1);
  expect(events.runs(committed, { turnId: "turn_0" })).toHaveLength(1);
  expect(events.session(pending).status).toBe("new");
});

it("projects interactions without exposing callback URLs through waiting or activity", () => {
  const view = events.foldEvents(
    events.emptySessionView(),
    stampTestEvents([
      ...opening.slice(0, 3),
      { type: "model.settled", data: { runId: "r", outcome: "completed" } },
      {
        type: "interaction.opened",
        data: {
          interactionId: "i",
          subject: { turnId: "turn_0" },
          request: {
            kind: "sign-in",
            title: "Connect",
            prompt: "Connect your account.",
            signIn: {
              name: "crm",
              url: "https://public.example/auth",
              callbackUrl: "https://private.example/callback",
            },
          },
        },
      },
    ]),
  );
  expect(events.openInteractions(view)).toHaveLength(1);
  const aboutTurn = events.openInteractions(view, { about: { turnId: "turn_0" } });
  expect(aboutTurn.map((row) => row.interactionId)).toEqual(["i"]);
  expect(Object.isFrozen(aboutTurn)).toBe(true);
  expect(Object.isFrozen(aboutTurn[0])).toBe(true);
  expect(events.openInteractions(view, { about: { responseId: "missing" } })).toEqual([]);
  expect(events.waiting(view, "turn_0")?.on).toBe("interaction");
  expect(events.activity(view).kind).toBe("waiting-on-interaction");
  expect(
    JSON.stringify([
      events.openInteractions(view),
      events.waiting(view, "turn_0"),
      events.activity(view),
    ]),
  ).not.toContain("private.example");
});
