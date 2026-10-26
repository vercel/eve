import { expect, it, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { createCompactionConfig } from "#execution/session.js";
import {
  readInterruptedAttempt,
  recoverInterruptedStep,
} from "#execution/session/interrupted-step.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { withOpenTurn, withPublished } from "#internal/testing/session-machine.js";

it.each([
  { outcome: "completed" as const, isError: false },
  { outcome: "failed" as const, isError: true },
])(
  "adopts a recorded $outcome session ending without restoring providers",
  async ({ outcome, isError }) => {
    const session: HarnessSession = {
      agent: { system: "", tools: [], dynamicModel: true },
      compaction: createCompactionConfig(),
      continuationToken: "test",
      history: [],
      sessionId: "ended-session",
    };
    const started = { type: "session.started" as const, data: {} };
    const ended = { type: "session.ended" as const, data: { outcome } };
    const recorded = withPublished(withPublished(session, [started]), [ended]);
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, session.sessionId);
    enterSessionProjection(ctx, recorded.state);
    const publish = vi.fn(async () => session);
    const at = "2026-10-21T00:00:00.000Z";
    const result = await recoverInterruptedStep({
      admission: [],
      attempt: readInterruptedAttempt(0, [
        { position: 0, line: { at, facts: [started] } },
        { position: 1, line: { at, facts: [ended] } },
      ]),
      ctx,
      publish,
      session,
      stepInput: undefined,
    });
    expect(result).toMatchObject({ result: { action: "done", isError, output: "" } });
    expect(publish).not.toHaveBeenCalled();
  },
);

function openTurnSession(sessionId: string) {
  const session: HarnessSession = {
    agent: { system: "", tools: [], dynamicModel: true },
    compaction: createCompactionConfig(),
    continuationToken: "test",
    history: [],
    sessionId,
  };
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, sessionId);
  return { ctx, session: withOpenTurn(session, { sequence: 1, turnId: "turn-1" }) };
}

it("fails the turn with what a step's last attempt threw", async () => {
  const { ctx, session } = openTurnSession("exhausted-session");
  enterSessionProjection(ctx, session.state);
  const published: SessionEvent[] = [];
  const result = await recoverInterruptedStep({
    admission: [],
    attempt: readInterruptedAttempt(0, []),
    ctx,
    failed: { error: Object.assign(new Error("write failed"), { code: "ENOSPC" }) },
    publish: async (events, current) => {
      published.push(...[events].flat());
      return current;
    },
    session,
    stepInput: undefined,
  });
  const settled = published.find((event) => event.type === "turn.settled");
  expect(settled?.data).toMatchObject({
    error: {
      code: "Disk full",
      hint: "Free up space and retry.",
      id: expect.any(String),
      message: "The disk is full, so writes are failing.",
    },
    outcome: "failed",
  });
  expect(result).toMatchObject({
    result: { settled: { isError: true, output: "The disk is full, so writes are failing." } },
  });
});

it("keeps the outcome of a turn an attempt settled when every attempt failed", async () => {
  const { ctx, session } = openTurnSession("settled-session");
  const settled = {
    type: "turn.settled" as const,
    data: { outcome: "completed" as const, turnId: "turn-1" },
  };
  const recorded = withPublished(session, [settled]);
  enterSessionProjection(ctx, recorded.state);
  const publish = vi.fn(async () => session);
  const result = await recoverInterruptedStep({
    admission: [],
    attempt: readInterruptedAttempt(0, [
      { position: 0, line: { at: "2026-10-21T00:00:00.000Z", facts: [settled] } },
    ]),
    ctx,
    failed: { error: new Error("The session stream is unavailable") },
    publish,
    session,
    stepInput: undefined,
  });
  expect(result).toMatchObject({ result: { action: "parked", settled: { isError: false } } });
  expect(publish).not.toHaveBeenCalled();
});

it("keeps a settled turn's imported history ahead of its message and reply", async () => {
  const { ctx, session } = openTurnSession("imported-session");
  const settled = {
    type: "turn.settled" as const,
    data: { outcome: "completed" as const, reply: ["p"], turnId: "turn-1" },
  };
  enterSessionProjection(ctx, withPublished(session, [settled]).state);
  const reply = {
    type: "content.completed",
    data: { kind: "text", partId: "p", value: "Hi Bob." },
  };
  const result = await recoverInterruptedStep({
    admission: [],
    attempt: readInterruptedAttempt(0, [
      { position: 0, line: { at: "2026-10-21T00:00:00.000Z", facts: [reply, settled] } },
    ]),
    ctx,
    publish: vi.fn(async () => session),
    session,
    stepInput: {
      history: [
        { role: "user", text: "Bob asked about the launch." },
        { role: "assistant", text: "It ships Friday." },
      ],
      message: "Thanks, Alice here.",
    },
  });
  expect("result" in result && result.result.history).toEqual([
    {
      content: "Bob asked about the launch.",
      kind: "user",
      metadata: { "eve.imported": true },
      role: "user",
    },
    { content: "It ships Friday.", role: "assistant" },
    expect.objectContaining({ content: "Thanks, Alice here.", role: "user" }),
    { content: "Hi Bob.", role: "assistant" },
  ]);
});
