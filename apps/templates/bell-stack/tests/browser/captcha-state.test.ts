import { describe, expect, it } from "vitest";

import {
  applyCaptchaTransition,
  applyTaskEvent,
  CAPTCHA_JOURNAL_LIMIT,
  reconcileCaptchaAfterRestart,
  type DurableTaskRecord,
} from "../../agent/lib/task-state.js";
import { parseBrowserbaseCaptchaEvent, safeCaptchaPage } from "../../lib/browser/captcha.js";

const empty = (): DurableTaskRecord => ({
  version: 1,
  taskId: "task_fixture",
  sessionId: "session_fixture",
  title: "Fixture",
  status: "running",
  browser: { lifecycle: "active" },
  processedEventIds: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
});
const transition = (type: "started" | "finished" | "errored" | "timed_out", n = 1) => ({
  id: `${type}-${n}`,
  type,
  at: `2026-09-05T00:00:${String(n).padStart(2, "0")}.000Z`,
  page: { origin: "https://example.test", path: "/challenge" },
});

describe("shared Browserbase CAPTCHA parser", () => {
  for (const [message, expected] of [
    ["browserbase-solving-started", "started"],
    ["browserbase-solving-finished", "finished"],
    ["browserbase-solving-errored", "errored"],
  ] as const)
    it(`parses ${expected}`, () =>
      expect(
        parseBrowserbaseCaptchaEvent({
          method: "Runtime.consoleAPICalled",
          params: { args: [{ type: "string", value: message }] },
        }),
      ).toBe(expected));
  it("rejects unrelated CDP events", () =>
    expect(
      parseBrowserbaseCaptchaEvent({
        method: "Runtime.executionContextCreated",
        params: {},
      }),
    ).toBeUndefined());
  it("stores only origin and path", () =>
    expect(safeCaptchaPage("https://example.test/challenge?token=secret#x")).toEqual({
      origin: "https://example.test",
      path: "/challenge",
    }));
});

describe("durable CAPTCHA reducer", () => {
  it("starts, finishes, and is idempotent", () => {
    let state = applyCaptchaTransition(empty(), transition("started"));
    state = applyCaptchaTransition(state, transition("started"));
    expect(state.captcha?.attemptCount).toBe(1);
    state = applyCaptchaTransition(state, transition("finished", 2));
    expect(state).toMatchObject({
      status: "running",
      captcha: { status: "solved" },
    });
  });
  it("enters human handoff on error", () => {
    let state = applyCaptchaTransition(empty(), transition("started"));
    state = applyCaptchaTransition(state, transition("errored", 2));
    expect(state).toMatchObject({
      status: "waiting_for_user",
      waitReason: "captcha",
      captcha: { status: "errored" },
    });
  });
  it("enters human handoff on timeout and ignores a late finish", () => {
    let state = applyCaptchaTransition(empty(), transition("started"));
    state = applyCaptchaTransition(state, transition("timed_out", 2));
    state = applyCaptchaTransition(state, transition("finished", 3));
    expect(state).toMatchObject({
      status: "waiting_for_user",
      captcha: { status: "timed_out" },
    });
  });
  it("bounds the transition journal", () => {
    let state = empty();
    for (let i = 1; i <= CAPTCHA_JOURNAL_LIMIT + 8; i++) {
      state = applyCaptchaTransition(state, transition("started", i));
      state = applyCaptchaTransition(state, transition("finished", i + 100));
    }
    expect(state.captcha?.journal).toHaveLength(CAPTCHA_JOURNAL_LIMIT);
  });
  it("keeps old records compatible", () =>
    expect(applyCaptchaTransition(empty(), transition("started")).captcha?.status).toBe("solving"));
  it("preserves solving across generic Eve events", () => {
    let state = applyCaptchaTransition(empty(), transition("started"));
    state = applyTaskEvent(
      state,
      {
        type: "step.started",
        meta: { id: "step", at: "2026-09-05T00:00:02.000Z" },
      },
      state.sessionId,
    );
    expect(state.status).toBe("solving_captcha");
  });
  it("reconciles stale solving state after restart", () => {
    const state = applyCaptchaTransition(empty(), transition("started"));
    expect(reconcileCaptchaAfterRestart(state, "2026-09-05T00:01:00.000Z", 30_000)).toMatchObject({
      status: "waiting_for_user",
      captcha: { status: "timed_out" },
    });
  });
  it("keeps a recent solving state after restart", () => {
    const state = applyCaptchaTransition(empty(), transition("started"));
    expect(reconcileCaptchaAfterRestart(state, "2026-09-05T00:00:20.000Z", 30_000).status).toBe(
      "solving_captcha",
    );
  });
  it("contains no query secrets or signed URLs", () => {
    const state = applyCaptchaTransition(empty(), {
      ...transition("started"),
      page: safeCaptchaPage("https://example.test/challenge?signed=secret"),
    });
    expect(JSON.stringify(state)).not.toContain("secret");
    expect(JSON.stringify(state)).not.toContain("?");
  });
});
