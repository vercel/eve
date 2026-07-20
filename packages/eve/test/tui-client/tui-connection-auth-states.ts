import { setTimeout as sleep } from "node:timers/promises";

import { ClientSession, MessageResponse, type HandleMessageStreamEvent } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

/**
 * Drives the full `authorization.*` lifecycle through the
 * runner + renderer without spinning up a real eve server. The other
 * smoke (`tui-connection-auth.ts`) covers the realistic `_required`
 * path through a live runtime, but the live runtime cannot easily
 * emit `_completed` in this repo (interactive auth
 * requires a `principalType: "user"` session, which apps/fixtures/agent-tui-client
 * doesn't currently provide). This smoke fills that gap with a
 * `FakeSession` that separates the parked request stream from the callback
 * continuation stream, so we get
 * deterministic coverage of:
 *
 *   1. `_required` with a populated challenge (URL, user code,
 *      instructions). That proves the renderer surfaces all three
 *      challenge fields, which the live smoke can't show.
 *   2. `_completed` with `outcome: "authorized"` after `session.waiting`.
 *      That proves the root TUI follows `session.stream()` until the OAuth
 *      callback resumes the durable workflow, flips the right-title, clears
 *      the status-bar override, and settles the section.
 *   3. A second turn with `outcome: "failed"` + a reason. That
 *      proves the failure path renders distinctly and the reason
 *      string surfaces in the section content.
 */

class FakeSession extends ClientSession {
  readonly #turns: ReadonlyArray<readonly HandleMessageStreamEvent[]>;
  readonly #continuations: ReadonlyArray<readonly HandleMessageStreamEvent[]>;
  #turnIndex = 0;
  #continuationIndex = 0;

  constructor(input: {
    turns: ReadonlyArray<readonly HandleMessageStreamEvent[]>;
    continuations: ReadonlyArray<readonly HandleMessageStreamEvent[]>;
  }) {
    super(
      {
        host: "http://fake.invalid",
        maxReconnectAttempts: 0,
        preserveCompletedSessions: false,
        resolveHeaders: async () => new Headers(),
      },
      { streamIndex: 0 },
    );
    this.#turns = input.turns;
    this.#continuations = input.continuations;
  }

  override async send<TOutput = unknown>(): Promise<MessageResponse<TOutput>> {
    const events = this.#turns[this.#turnIndex] ?? [];
    this.#turnIndex += 1;
    return new MessageResponse<TOutput>({
      sessionId: "fake-session",
      continuationToken: `fake-token-${this.#turnIndex}`,
      createStream: () => pacedEvents(events),
    });
  }

  override stream(): AsyncIterable<HandleMessageStreamEvent> {
    const events = this.#continuations[this.#continuationIndex] ?? [];
    this.#continuationIndex += 1;
    return pacedEvents(events);
  }
}

async function* pacedEvents(
  events: readonly HandleMessageStreamEvent[],
): AsyncGenerator<HandleMessageStreamEvent> {
  for (const event of events) {
    yield event;
    // Pacing gives the renderer and smoke assertions a chance to observe
    // each lifecycle state between events, as the HTTP transport does live.
    await sleep(200);
  }
}

const turnId = "turn-0";
const stepIndex = 0;

let sequence = 0;
const next = () => ++sequence;

const firstTurn: HandleMessageStreamEvent[] = [
  { type: "session.started", data: {} },
  { type: "turn.started", data: { sequence: next(), turnId } },
  { type: "step.started", data: { sequence: next(), stepIndex, turnId } },
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
    data: { continuationToken: "eve:test", wait: "next-user-message" },
  },
];

const firstCallbackTurn: HandleMessageStreamEvent[] = [
  {
    type: "authorization.completed",
    data: {
      name: "stub-mcp",
      outcome: "authorized",
      sequence: next(),
      stepIndex,
      turnId,
    },
  },
  {
    type: "step.completed",
    data: { finishReason: "stop", sequence: next(), stepIndex, turnId },
  },
  {
    type: "session.waiting",
    data: { continuationToken: "eve:test", wait: "next-user-message" },
  },
];

const secondTurnId = "turn-1";
const secondTurn: HandleMessageStreamEvent[] = [
  { type: "turn.started", data: { sequence: next(), turnId: secondTurnId } },
  { type: "step.started", data: { sequence: next(), stepIndex, turnId: secondTurnId } },
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
    data: { continuationToken: "eve:test", wait: "next-user-message" },
  },
];

const secondCallbackTurn: HandleMessageStreamEvent[] = [
  {
    type: "authorization.completed",
    data: {
      name: "other-mcp",
      outcome: "failed",
      reason: "access_denied",
      sequence: next(),
      stepIndex,
      turnId: secondTurnId,
    },
  },
  {
    type: "step.completed",
    data: { finishReason: "stop", sequence: next(), stepIndex, turnId: secondTurnId },
  },
  {
    type: "session.waiting",
    data: { continuationToken: "eve:test", wait: "next-user-message" },
  },
];

process.env.EVE_TUI_UNICODE = "1";

void (async () => {
  const session = new FakeSession({
    turns: [firstTurn, secondTurn],
    continuations: [firstCallbackTurn, secondCallbackTurn],
  });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session,
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
    await screen.waitForText("❯", 5_000);

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

    await waitForCondition(
      () => !screen.snapshot().includes("Waiting for connection authorization"),
      {
        timeoutMs: 5_000,
        label: "status-bar override cleared after completed",
        onTimeout: () => screen.snapshot(),
      },
    );
    console.log(theme.muted("[states] status-bar override cleared after authorized"));

    // Wait for the runner to loop back into `readPrompt` before typing
    // the next message. Without this, `MockUserInput.type` emits onto an
    // event emitter that no listener is currently subscribed to (the
    // first turn's data handler was detached when the stream finished),
    // and the input event is silently dropped. The bottom-bar status
    // text changes to "Type a prompt and press Enter" exactly when
    // `readPrompt` attaches a fresh handler.
    // Wait for the first turn's stream to fully drain (events after the
    // last asserted state, `step.completed`, `session.waiting`, plus
    // the renderStream finally and the runner's loop-back into
    // `readPrompt`). 1s is comfortable headroom over the empirical
    // ~600ms needed for the synthetic stream's per-event pacing. The
    // "Type a prompt and press Enter" status text the renderer sets in
    // `readPrompt` is NOT visible in the snapshot, when input is
    // active, the bottom line shows the `> █` input prompt instead of
    // `#status`, so a sleep is the simplest reliable barrier.
    await sleep(1000);

    // ---- Turn 2: other-mcp, ends in `failed` with a reason ----

    input.type("turn 2, drive other-mcp through required → failed");
    input.enter();

    await screen.waitForText("● other-mcp · authorization", 10_000);
    console.log(theme.muted("[states] other-mcp section header rendered"));

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
    // Ctrl+C exits the session. A Ctrl+C mid-stream now only interrupts the
    // turn and returns to the prompt (Claude Code's two-step exit).
    await screen.waitForText("❯", 10_000);
    input.ctrlC();
    await runPromise;
  } catch (error) {
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
