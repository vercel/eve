import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { EveTUIRunner, FakeEveServer, MockScreen, MockUserInput } from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

/**
 * Drives the full `authorization.*` lifecycle through the
 * runner + renderer without spinning up a real eve server. The other
 * smoke (`tui-connection-auth.ts`) covers the realistic `_required`
 * path through a live runtime, but the live runtime cannot easily
 * emit `_completed` in this repo (interactive auth
 * requires a `principalType: "user"` session, which apps/fixtures/agent-tui-client
 * doesn't currently provide). This smoke fills that gap with an in-memory
 * eve server whose callback continuation the smoke emits after asserting the
 * parked challenge, so we get deterministic coverage of:
 *
 *   1. `_required` with a populated challenge (URL, user code,
 *      instructions). That proves the renderer surfaces all three
 *      challenge fields, which the live smoke can't show.
 *   2. `_completed` with `outcome: "authorized"` after `session.waiting`.
 *      That proves the TUI keeps following the session until the OAuth
 *      callback resumes the durable workflow, flips the right-title, and
 *      settles the section.
 *   3. A second turn with `outcome: "failed"` + a reason. That
 *      proves the failure path renders distinctly and the reason
 *      string surfaces in the section content.
 */

const turnId = "turn-0";
const stepIndex = 0;

let sequence = 0;
const next = () => ++sequence;

const firstTurn: UnstampedMessageStreamEvent[] = [
  { type: "session.started", data: {} },
  { type: "turn.started", data: { sequence: next(), turnId } },
  { type: "step.started", data: { modelId: "eve-mock/test", sequence: next(), stepIndex, turnId } },
  {
    type: "authorization.required",
    data: {
      authorization: {
        url: "https://example.com/authorize/stub-mcp",
        userCode: "STUB-1234",
        instructions: "Visit the URL above and enter the user code.",
      },
      name: "stub-mcp",
      description: "Stub MCP server",
      sequence: next(),
      stepIndex,
      turnId,
      webhookUrl: "http://localhost:3000/eve/v1/connections/stub-mcp/callback/xyz",
    },
  },
  {
    type: "step.completed",
    data: { finishReason: "stop", sequence: next(), stepIndex, turnId },
  },
  {
    type: "session.waiting",
    data: { continuationToken: "session-id", wait: "next-user-message" },
  },
];

const firstCallbackTurn: UnstampedMessageStreamEvent[] = [
  { type: "turn.started", data: { sequence: next(), turnId: "turn-1" } },
  {
    type: "authorization.completed",
    data: {
      name: "stub-mcp",
      outcome: "authorized",
      sequence: next(),
      stepIndex,
      turnId: "turn-1",
    },
  },
  {
    type: "step.completed",
    data: { finishReason: "stop", sequence: next(), stepIndex, turnId: "turn-1" },
  },
  { type: "turn.completed", data: { sequence: next(), turnId: "turn-1" } },
  {
    type: "session.waiting",
    data: { continuationToken: "session-id", wait: "next-user-message" },
  },
];

const secondTurnId = "turn-2";
const secondTurn: UnstampedMessageStreamEvent[] = [
  { type: "turn.started", data: { sequence: next(), turnId: secondTurnId } },
  {
    type: "step.started",
    data: { modelId: "eve-mock/test", sequence: next(), stepIndex, turnId: secondTurnId },
  },
  {
    type: "authorization.required",
    data: {
      authorization: {
        url: "https://example.com/authorize/other-mcp",
      },
      name: "other-mcp",
      description: "Other MCP server",
      sequence: next(),
      stepIndex,
      turnId: secondTurnId,
      webhookUrl: "http://localhost:3000/eve/v1/connections/other-mcp/callback/xyz",
    },
  },
  {
    type: "step.completed",
    data: { finishReason: "stop", sequence: next(), stepIndex, turnId: secondTurnId },
  },
  {
    type: "session.waiting",
    data: { continuationToken: "session-id", wait: "next-user-message" },
  },
];

const secondCallbackTurn: UnstampedMessageStreamEvent[] = [
  { type: "turn.started", data: { sequence: next(), turnId: "turn-3" } },
  {
    type: "authorization.completed",
    data: {
      name: "other-mcp",
      outcome: "failed",
      reason: "access_denied",
      sequence: next(),
      stepIndex,
      turnId: "turn-3",
    },
  },
  {
    type: "step.completed",
    data: { finishReason: "stop", sequence: next(), stepIndex, turnId: "turn-3" },
  },
  { type: "turn.completed", data: { sequence: next(), turnId: "turn-3" } },
  {
    type: "session.waiting",
    data: { continuationToken: "session-id", wait: "next-user-message" },
  },
];

process.env.EVE_TUI_UNICODE = "1";

void (async () => {
  const server = new FakeEveServer(({ deliveryId }) =>
    deliveryId === "delivery_1" ? firstTurn : secondTurn,
  );
  globalThis.fetch = server.fetch;
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    client: new Client({ host: "http://fake.invalid" }),
    screen,
    userInput: input,
    name: "TUI states smoke",
  });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  try {
    await screen.waitForIdlePrompt(5_000);

    // ---- Turn 1: stub-mcp, ends in `authorized` ----

    input.type("turn 1, drive stub-mcp through required → authorized");
    input.enter();

    await screen.waitForText("● stub-mcp · authorization", 10_000);
    console.log(theme.muted("[states] stub-mcp section header rendered"));

    await waitForCondition(
      () => {
        const snap = screen.snapshot();
        return (
          snap.includes("URL: https://example.com/authorize/stub-mcp") &&
          snap.includes("Code: STUB-1234") &&
          snap.includes("Visit the URL above")
        );
      },
      {
        timeoutMs: 5_000,
        label: "challenge URL + user code + instructions in section body",
        onTimeout: () => screen.snapshot(),
      },
    );
    console.log(theme.muted("[states] URL, code, and instructions all rendered"));

    // The browser completes the grant; the callback resumes the parked session.
    server.emit(firstCallbackTurn);

    await waitForCondition(() => screen.snapshot().includes("authorized"), {
      timeoutMs: 10_000,
      label: "authorized right-title",
      onTimeout: () => screen.snapshot(),
    });
    console.log(theme.muted("[states] right-title flipped to authorized"));

    await waitForCondition(
      () => {
        const snap = screen.snapshot();
        return (
          snap.includes("Authorization complete") &&
          !snap.includes("Authorization required for stub-mcp") &&
          !snap.includes("URL: https://example.com/authorize/stub-mcp") &&
          !snap.includes("Code: STUB-1234") &&
          !snap.includes("Visit the URL above")
        );
      },
      {
        timeoutMs: 5_000,
        label: "completed authorization replaces the stale challenge body",
        onTimeout: () => screen.snapshot(),
      },
    );
    console.log(theme.muted("[states] completed authorization body replaced the challenge"));

    // Let the first turn settle so the next message starts a new turn
    // instead of steering this one.
    await screen.waitForIdlePrompt(5_000);

    // ---- Turn 2: other-mcp, ends in `failed` with a reason ----

    input.type("turn 2, drive other-mcp through required → failed");
    input.enter();

    await screen.waitForText("● other-mcp · authorization", 10_000);
    console.log(theme.muted("[states] other-mcp section header rendered"));
    server.emit(secondCallbackTurn);

    await waitForCondition(() => screen.snapshot().includes("failed"), {
      timeoutMs: 10_000,
      label: "failed right-title",
      onTimeout: () => screen.snapshot(),
    });

    await waitForCondition(() => screen.snapshot().includes("Reason: access_denied"), {
      timeoutMs: 2_000,
      label: "failure reason in section body",
      onTimeout: () => screen.snapshot(),
    });
    console.log(theme.muted("[states] failure reason surfaced"));

    // The turn is complete; wait until the runner is back at the prompt so
    // Two idle Ctrl+C presses exit; mid-stream Ctrl+C cancels cooperatively.
    await screen.waitForIdlePrompt(10_000);
    input.ctrlC();
    input.ctrlC();
    await runPromise;
    server.close();
  } catch (error) {
    input.ctrlC();
    input.ctrlC();
    await runPromise.catch(() => undefined);
    throw error;
  }
})().catch((error: unknown) => {
  console.error(theme.danger("\n[tui] tui-connection-auth-states smoke test failed:"), error);
  process.exitCode = 1;
});

async function waitForCondition(
  predicate: () => boolean,
  options: {
    timeoutMs: number;
    label: string;
    intervalMs?: number;
    onTimeout?: () => string;
  },
): Promise<void> {
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  const extra = options.onTimeout?.() ?? "";
  throw new Error(`Timed out waiting for: ${options.label}${extra ? `\n\n${extra}` : ""}`);
}
