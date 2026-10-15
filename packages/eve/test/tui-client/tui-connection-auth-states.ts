import type { SessionEvent } from "#protocol/session-event.js";
import type { InteractionSettledData } from "#protocol/session-events/families/interaction.js";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
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
 *   2. `_completed` with `outcome: "authorized"` after the turn pauses on the sign-in.
 *      That proves the TUI keeps following the session until the OAuth
 *      callback resumes the durable workflow, flips the right-title, and
 *      settles the section.
 *   3. A second turn with `outcome: "failed"` + a reason. That
 *      proves the failure path renders distinctly and the reason
 *      string surfaces in the section content.
 */

/** A turn that opens a sign-in for `name` and pauses on it, answering its delivery for now. */
function signInTurn(input: {
  readonly deliveryId: string;
  readonly turnId: string;
  readonly name: string;
  readonly description: string;
  readonly signIn: {
    readonly url: string;
    readonly userCode?: string;
    readonly instructions?: string;
  };
  readonly started?: boolean;
}): SessionEvent[] {
  const { deliveryId, turnId } = input;
  const runId = `${turnId}.run`;
  const scope = { turnId };
  const interactionId = `${input.name}-attempt`;
  const opening: SessionEvent[] =
    input.started === true ? [] : [{ type: "session.started", data: {} }];
  return [
    ...opening,
    { type: "delivery.admitted", data: { deliveryId } },
    { type: "turn.started", data: { cause: { deliveryId }, follows: null, turnId }, scope },
    { type: "delivery.consumed", data: { deliveryId, parts: [], turnId }, scope },
    { type: "model.requested", data: { owner: { turnId }, runId }, scope: { runId, turnId } },
    { type: "model.started", data: { modelId: "eve-mock/test", runId }, scope: { runId, turnId } },
    {
      type: "model.settled",
      data: { finishReason: "stop", outcome: "completed", runId },
      scope: { runId, turnId },
    },
    {
      type: "interaction.opened",
      data: {
        interactionId,
        request: {
          kind: "sign-in",
          prompt: input.description,
          signIn: { name: input.name, ...input.signIn },
        },
        subject: { turnId },
      },
      scope,
    },
    { type: "turn.paused", data: { awaiting: [{ interactionId }], turnId }, scope },
    { type: "delivery.settled", data: { deliveryId, outcome: "awaiting-input", turnId } },
  ];
}

/** The sign-in's callback: it settles the interaction, and the turn resumes and completes. */
function callbackTurn(input: {
  readonly turnId: string;
  readonly name: string;
  readonly outcome: "accepted" | "failed";
  readonly reason?: string;
}): SessionEvent[] {
  const { turnId } = input;
  const scope = { turnId };
  const interactionId = `${input.name}-attempt`;
  const deliveryId = `${input.name}-callback`;
  const responseId = `${input.name}-response`;
  const settled: { -readonly [K in keyof InteractionSettledData]: InteractionSettledData[K] } = {
    cause: { responseId },
    interactionId,
    outcome: input.outcome,
  };
  if (input.reason !== undefined) settled.reason = input.reason;
  return [
    { type: "delivery.admitted", data: { deliveryId, source: { callback: input.name } } },
    { type: "response.submitted", data: { deliveryId, interactionId, responseId } },
    {
      type: "response.settled",
      data: { outcome: input.outcome === "accepted" ? "applied" : "failed", responseId },
    },
    {
      type: "interaction.settled",
      data: settled,
      scope,
    },
    { type: "turn.resumed", data: { cause: { deliveryId }, turnId }, scope },
    { type: "delivery.settled", data: { deliveryId, outcome: "applied", turnId } },
    { type: "turn.settled", data: { outcome: "completed", turnId }, scope },
  ];
}

const firstTurn = signInTurn({
  deliveryId: "delivery_1",
  turnId: "turn_0",
  name: "stub-mcp",
  description: "Stub MCP server",
  signIn: {
    url: "https://example.com/authorize/stub-mcp",
    userCode: "STUB-1234",
    instructions: "Visit the URL above and enter the user code.",
  },
});
const firstCallbackTurn = callbackTurn({
  turnId: "turn_0",
  name: "stub-mcp",
  outcome: "accepted",
});
const secondTurn = signInTurn({
  deliveryId: "delivery_2",
  turnId: "turn_1",
  name: "other-mcp",
  description: "Other MCP server",
  signIn: { url: "https://example.com/authorize/other-mcp" },
  started: true,
});
const secondCallbackTurn = callbackTurn({
  turnId: "turn_1",
  name: "other-mcp",
  outcome: "failed",
  reason: "access_denied",
});

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

    await screen.waitForText("● Stub-mcp · authorization", 10_000);
    console.log(theme.muted("[states] stub-mcp section header rendered"));

    await waitForCondition(
      () => {
        const snap = screen.snapshot();
        return (
          snap.includes("https://example.com/authorize/stub-mcp") &&
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
          !snap.includes("https://example.com/authorize/stub-mcp") &&
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

    await screen.waitForText("● Other-mcp · authorization", 10_000);
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
    // A runner stuck mid-turn may ignore Ctrl+C; don't let that mask the failure.
    await Promise.race([runPromise.catch(() => undefined), sleep(2_000)]);
    throw error;
  }
})().catch((error: unknown) => {
  console.error(theme.danger("\n[tui] tui-connection-auth-states smoke test failed:"), error);
  process.exit(1);
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
