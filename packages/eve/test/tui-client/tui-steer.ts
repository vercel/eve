import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { run } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof of steer-on-Enter, single-Esc cooperative cancellation,
 * and double-Ctrl+C exit against a live server:
 *
 *   1. Start a long turn, then press Enter on a follow-up while it streams.
 *      The message steers immediately without entering the queue panel.
 *   2. The steered message is answered and the runner returns to an idle prompt.
 *   3. With no message queued, one Esc cancels another long turn, then a
 *      follow-up succeeds on the preserved session.
 *
 * The tokens prove delivery order end-to-end: each must appear twice
 * (the echoed user block and the model's reply).
 */

const STEER_TOKEN = "STEER-MARKER-B7Q";
const CANCEL_FOLLOW_UP_TOKEN = "CANCEL-FOLLOW-UP-MARKER-P8N";
process.env.EVE_TUI_UNICODE = "1";

run({ app: "agent-tui-client", kind: "local-build" }, async (target) => {
  const client = new Client({ host: target.baseUrl });
  const screen = new MockScreen({ columns: 110, rows: 44 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    client,
    screen,
    userInput: input,
    name: "TUI steer smoke",
  });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  await screen.waitForIdlePrompt(5_000);

  // A long first turn holds the stream open while Enter submits steering.
  input.type("Write a short story of about 150 words about tides. Do not use any tools.");
  input.enter();
  await waitForActiveTurn(screen, 30_000);

  input.type(`Reply with one short sentence containing the token ${STEER_TOKEN}.`);
  const steeringOutputStart = screen.rawOutput().length;
  input.enter();

  await waitForTwice(screen, STEER_TOKEN, 120_000, "steered turn echo + reply");
  if (screen.rawOutput().slice(steeringOutputStart).includes("Queue 1/5")) {
    throw new Error(`Enter queued the follow-up instead of steering:\n${screen.snapshot()}`);
  }
  console.log(theme.muted("[tui-steer] steered message answered"));

  await screen.waitForIdlePrompt(60_000);

  const cancellationOutputStart = screen.rawOutput().length;
  input.type("Write a story of about 500 words about lighthouses. Do not use any tools.");
  input.enter();
  await waitForActiveTurn(screen, 30_000);

  // With no queued message, the first Esc cooperatively cancels the turn.
  input.emit("data", Buffer.from("\x1b"));
  await sleep(60);
  await waitForRawOutput(
    screen,
    "Cancelled",
    cancellationOutputStart,
    30_000,
    "single-Esc cancellation",
  );
  await screen.waitForIdlePrompt(30_000);
  console.log(theme.muted("[tui-steer] one empty-queue Esc cancelled the turn"));

  input.type(`Reply with one short sentence containing the token ${CANCEL_FOLLOW_UP_TOKEN}.`);
  input.enter();
  await waitForTwice(screen, CANCEL_FOLLOW_UP_TOKEN, 120_000, "post-cancellation follow-up");
  await screen.waitForIdlePrompt(60_000);
  console.log(theme.muted("[tui-steer] preserved session answered after cancellation"));

  input.ctrlC();
  await screen.waitForText("Press Ctrl+C again to exit", 5_000);
  input.ctrlC();
  await runPromise;
});

async function waitForActiveTurn(screen: MockScreen, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = screen.snapshot();
    if (/^[•* ] (?:Thinking|Generating|Running) \(\d/mu.test(snapshot) && /^❯/mu.test(snapshot)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for an active turn.\n\nScreen:\n${screen.snapshot()}`);
}

/** Waits until `token` appears at least twice: the echoed prompt and the reply. */
async function waitForTwice(
  screen: MockScreen,
  token: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (screen.snapshot().split(token).length > 2) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${label}\n${screen.snapshot()}`);
}

async function waitForRawOutput(
  screen: MockScreen,
  text: string,
  start: number,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (screen.rawOutput().slice(start).includes(text)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${label}\n${screen.snapshot()}`);
}
