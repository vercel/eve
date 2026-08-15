import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { run } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof of the mid-turn message queue, Ctrl+C steering, single-Esc
 * cooperative cancellation, and double-Ctrl+C exit against a live server:
 *
 *   1. Start a long turn, then submit two messages while it streams —
 *      both must land in the pinned `↑ Queue n/5` panel, not the turn.
 *   2. Ctrl+C pops the oldest queued message: the panel flips to Steering,
 *      the running turn settles as `turn.cancelled` → `session.waiting`
 *      (cooperative — the session keeps its context), and the popped
 *      message runs as the replacement turn.
 *   3. The remaining queued message auto-drains as the following turn.
 *   4. The steered echo carries the `↑` provenance arrow above its bar,
 *      the queued one below, and the runner returns to an idle prompt.
 *   5. With no message queued, one Esc cancels another long turn, then a
 *      follow-up succeeds on the preserved session.
 *
 * The tokens prove delivery order end-to-end: each must appear twice
 * (the echoed user block and the model's reply).
 */

const STEER_TOKEN = "STEER-MARKER-B7Q";
const QUEUE_TOKEN = "QUEUE-MARKER-K4Z";
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
    name: "TUI queue/steer smoke",
  });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  await screen.waitForIdlePrompt(5_000);

  // A long first turn holds the stream open while messages queue behind it.
  input.type("Write a short story of about 150 words about tides. Do not use any tools.");
  input.enter();
  await screen.waitForText("Working for", 30_000);

  input.type(`Reply with one short sentence containing the token ${STEER_TOKEN}.`);
  input.enter();
  await screen.waitForText("Queue 1/5", 10_000);
  input.type(`Reply with one short sentence containing the token ${QUEUE_TOKEN}.`);
  input.enter();
  await screen.waitForText("Queue 2/5", 10_000);
  console.log(theme.muted("[tui-queue-steer] two messages queued behind the running turn"));

  // Ctrl+C pops the oldest message and cooperatively cancels the running turn.
  input.ctrlC();
  await screen.waitForText("Steering", 10_000);
  console.log(theme.muted("[tui-queue-steer] steering engaged, cancelling the turn"));

  await waitForTwice(screen, STEER_TOKEN, 120_000, "steered turn echo + reply");
  console.log(theme.muted("[tui-queue-steer] steered message answered"));

  await waitForTwice(screen, QUEUE_TOKEN, 120_000, "auto-drained turn echo + reply");
  console.log(theme.muted("[tui-queue-steer] remaining queue auto-drained"));

  await screen.waitForIdlePrompt(60_000);

  // Provenance arrows: steered above its bar, queued below.
  const lines = screen.snapshot().split("\n");
  const steerEcho = lines.findIndex((line) =>
    line.includes(`│ Reply with one short sentence containing the token ${STEER_TOKEN}`),
  );
  if (steerEcho <= 0 || lines[steerEcho - 1]?.trim() !== "↑") {
    throw new Error(
      `Steered echo is missing its ↑ marker above the bar:\n${lines
        .slice(Math.max(0, steerEcho - 2), steerEcho + 1)
        .join("\n")}`,
    );
  }
  const queueEcho = lines.findIndex((line) =>
    line.includes(`│ Reply with one short sentence containing the token ${QUEUE_TOKEN}`),
  );
  if (queueEcho < 0 || lines[queueEcho + 1]?.trim() !== "↑") {
    throw new Error(
      `Queued echo is missing its ↑ marker below the bar:\n${lines
        .slice(queueEcho, queueEcho + 3)
        .join("\n")}`,
    );
  }
  console.log(theme.muted("[tui-queue-steer] provenance arrows rendered"));

  const cancellationOutputStart = screen.rawOutput().length;
  input.type("Write a story of about 500 words about lighthouses. Do not use any tools.");
  input.enter();
  await screen.waitForText("Working for", 30_000);

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
  console.log(theme.muted("[tui-queue-steer] one empty-queue Esc cancelled the turn"));

  input.type(`Reply with one short sentence containing the token ${CANCEL_FOLLOW_UP_TOKEN}.`);
  input.enter();
  await waitForTwice(screen, CANCEL_FOLLOW_UP_TOKEN, 120_000, "post-cancellation follow-up");
  await screen.waitForIdlePrompt(60_000);
  console.log(theme.muted("[tui-queue-steer] preserved session answered after cancellation"));

  input.ctrlC();
  await screen.waitForText("Press Ctrl+C again to exit", 5_000);
  input.ctrlC();
  await runPromise;
});

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
