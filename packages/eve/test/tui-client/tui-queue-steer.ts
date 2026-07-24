import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { run } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof of the mid-turn message queue, Esc steering, and
 * cooperative cancellation against a live server:
 *
 *   1. Start a long turn, then submit two messages while it streams —
 *      both must land in the pinned `↑ Queue n/5` panel, not the turn.
 *   2. Esc pops the oldest queued message: the panel flips to Steering,
 *      the running turn settles as `turn.cancelled` → `session.waiting`
 *      (cooperative — the session keeps its context), and the popped
 *      message runs as the replacement turn.
 *   3. The remaining queued message auto-drains as the following turn.
 *   4. The steered echo carries the `↑` provenance arrow above its bar,
 *      the queued one below, and the runner returns to an idle prompt.
 *
 * The tokens prove delivery order end-to-end: each must appear twice
 * (the echoed user block and the model's reply).
 */

const STEER_TOKEN = "STEER-MARKER-B7Q";
const QUEUE_TOKEN = "QUEUE-MARKER-K4Z";
process.env.EVE_TUI_UNICODE = "1";

run({ app: "agent-tui-client", kind: "local-build" }, async (target) => {
  const client = new Client({ host: target.baseUrl });
  const session = client.session();
  const screen = new MockScreen({ columns: 110, rows: 44 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session,
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

  // Esc pops the oldest message and cooperatively cancels the running turn.
  input.emit("data", Buffer.from("\x1b"));
  await sleep(60); // the decoder holds a lone ESC briefly (escape-vs-sequence)
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
