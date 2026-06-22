import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { run } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof that the TUI handles `input.requested` events with
 * `display: "select"` correctly. The legacy translator collapsed every
 * input request into a `tool-approval-request` chunk, so multi-option
 * `ask_question` calls were unanswerable through the TUI. This smoke
 * test drives the new `readInputQuestion` path:
 *
 *   1. Start the apps/fixtures/agent-tui-client server.
 *   2. Boot an `EveTUIRunner` with a mock terminal.
 *   3. Type a prompt that asks the model to call `ask_question` with
 *      two options (red/blue).
 *   4. Wait for the question section to display the select indicator
 *      (`▶ <label>`), which proves the dedicated question UI is up.
 *   5. Send Down arrow + Enter to pick the second option (blue).
 *   6. Wait for the answered marker in the body section.
 *   7. Wait for the post-answer assistant turn to render. The runner
 *      only returns to its prompt-reading state if the chosen option
 *      flowed through to the agent and resolved the pending input.
 */

const RED_ID = "red";
const BLUE_ID = "blue";
process.env.EVE_TUI_UNICODE = "1";

run({ app: "agent-tui-client", kind: "local-build" }, async (target) => {
  const client = new Client({ host: target.baseUrl });
  const session = client.session();
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session,
    screen,
    userInput: input,
    name: "TUI smoke",
  });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  await screen.waitForText("❯", 5_000);

  const promptLines = [
    "Use the ask_question tool exactly once to ask me which color I prefer.",
    "Set prompt to: 'Pick a color.'",
    "Provide exactly two options:",
    `- id "${RED_ID}", label "Red"`,
    `- id "${BLUE_ID}", label "Blue"`,
    "Wait for my response.",
  ];
  input.type(promptLines.join(" · "));
  input.enter();

  await screen.waitForText("▶ Red", 60_000);
  console.log(theme.muted("[tui-questions] select UI is live, highlight on Red"));

  // Bridges a server-side race where the park hook isn't yet
  // registered when `session.waiting` reaches the client. The TUI
  // is human-paced in practice; scripted clients need a short
  // handshake delay before delivering the response.
  await sleep(500);

  input.emit("data", Buffer.from("\x1B[B"));
  await screen.waitForText("▶ Blue", 2_000);
  console.log(theme.muted("[tui-questions] highlight moved to Blue"));

  input.enter();

  await screen.waitForText("✓ Blue", 5_000);
  console.log(theme.muted("[tui-questions] answer recorded in body"));

  // The post-answer turn must produce a `▲`-prefixed assistant
  // section whose body contains "blue", proof that the chosen
  // optionId flowed through to the agent and the model produced a
  // reply reflecting the choice. We only search the region after the
  // "✓ Blue" answer marker to avoid a false positive from the marker
  // itself (transcript blocks commit in order, so the follow-up reply
  // always renders below the answered question).
  await waitForCondition(() => assistantReplyAfter(screen.snapshot(), "✓ Blue", "blue"), {
    timeoutMs: 60_000,
    label: "follow-up assistant section mentioning blue",
  });
  console.log(theme.muted("[tui-questions] follow-up assistant turn rendered"));

  const finalSnapshot = screen.snapshot();
  if (finalSnapshot.includes("Error")) {
    throw new Error(`Final screen contains an Error section:\n${finalSnapshot}`);
  }

  // The turn is complete; wait until the runner is back at the prompt so
  // Ctrl+C exits the session. A Ctrl+C mid-stream now only interrupts the
  // turn and returns to the prompt (Claude Code's two-step exit).
  await screen.waitForText("❯", 30_000);
  input.ctrlC();
  await runPromise;
});

/**
 * True when an assistant section (a `▲`-prefixed line and its wrapped
 * continuations) below `afterMarker` contains `needle`. Used to assert a
 * follow-up reply without matching transcript content above the marker.
 */
function assistantReplyAfter(snapshot: string, afterMarker: string, needle: string): boolean {
  const markerIndex = snapshot.indexOf(afterMarker);
  if (markerIndex === -1) return false;
  const region = snapshot.slice(markerIndex + afterMarker.length);
  const brandIndex = region.indexOf("▲ ");
  if (brandIndex === -1) return false;
  return region.slice(brandIndex).toLowerCase().includes(needle.toLowerCase());
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs: number; label: string; intervalMs?: number },
): Promise<void> {
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${options.label}`);
}
