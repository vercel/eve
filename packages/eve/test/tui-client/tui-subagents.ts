import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

// Note: the apps/fixtures/agent-tui-client's echo-marker subagent is the source of every child
// stream event the TUI observes here. The smoke validates the full pipeline:
// parent subagent.called → child session subscription → nested `│` region
// populated from the child's message.completed → parent subagent.completed.

import { run } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof that the TUI surfaces subagent stream events as a
 * persistent body section.
 *
 * Previously, `subagent.called`/`.started`/`.event`/`.completed` events
 * fell into the translator's `default:` arm and were dropped, the user
 * just saw a long pause. This smoke test drives the new subagent
 * section path against the `echo-marker` fixture:
 *
 *   1. Start the apps/fixtures/agent-tui-client server.
 *   2. Boot an `EveTUIRunner` with a mock terminal.
 *   3. Type the same delegation prompt the non-TUI subagent smoke uses.
 *   4. Wait for the `※ subagent(echo-marker…)` region header to appear.
 *   5. Wait for the nested region to contain the marker token.
 *   6. Verify the parent assistant message also contains the token. The
 *      rendering side-channel must not have broken the harness path.
 */

const SUBAGENT_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
process.env.EVE_TUI_UNICODE = "1";

run({ app: "agent-tui-client", kind: "local-build" }, async (target) => {
  const client = new Client({ host: target.baseUrl });
  const session = client.session();
  const screen = new MockScreen({ columns: 120, rows: 50 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session,
    client,
    screen,
    userInput: input,
    name: "TUI subagent smoke",
  });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  await screen.waitForIdlePrompt(5_000);

  input.type(
    "Use the echo marker subagent to process the input 'ping'. Once it returns, reply with the subagent's exact output included verbatim in your message.",
  );
  input.enter();

  await screen.waitForText("※ subagent(echo-marker", 90_000);
  console.log(theme.muted("[tui-subagents] subagent region header appeared"));

  await waitForCondition(() => screen.snapshot().includes(SUBAGENT_TOKEN), {
    timeoutMs: 90_000,
    label: "subagent message text landed in body",
  });
  console.log(theme.muted("[tui-subagents] subagent message text landed in body"));

  // The child side is proven above (the token streamed into the live
  // subagent body). Once the child settles, its section collapses to the
  // `└ Done` footnote and the token leaves the screen — so the parent side
  // is proven on its own: the verbatim echo must land in a top-level
  // `▲`-prefixed assistant section, not just inside the nested `│` region.
  // Whether the model also emits a pre-delegation message is
  // model-dependent, so the section count is not asserted.
  await waitForCondition(() => assistantSectionContains(screen.snapshot(), SUBAGENT_TOKEN), {
    timeoutMs: 120_000,
    label: "parent assistant section containing the token",
    onTimeout: () => screen.snapshot(),
  });
  console.log(theme.muted("[tui-subagents] parent assistant reply rendered with token"));

  const finalSnapshot = screen.snapshot();
  if (finalSnapshot.includes("Error")) {
    throw new Error(`Final screen contains an Error section:\n${finalSnapshot}`);
  }

  // The turn is complete; wait until the runner is back at the prompt so
  // Ctrl+C exits the session. A Ctrl+C mid-stream now only interrupts the
  // turn and returns to the prompt (Claude Code's two-step exit).
  await screen.waitForIdlePrompt(30_000);
  input.ctrlC();
  await runPromise;
});

/**
 * True when a top-level assistant section (a `▲ `-prefixed line and its
 * two-space-indented continuations) contains `needle`.
 */
function assistantSectionContains(snapshot: string, needle: string): boolean {
  const lines = snapshot.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.startsWith("▲ ")) continue;
    let body = line.slice(2);
    for (let next = index + 1; next < lines.length; next += 1) {
      const continuation = lines[next];
      if (continuation === undefined || !continuation.startsWith("  ")) break;
      body += `\n${continuation}`;
    }
    if (body.includes(needle)) return true;
  }
  return false;
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs: number; label: string; intervalMs?: number; onTimeout?: () => string },
): Promise<void> {
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  const detail = options.onTimeout === undefined ? "" : `\n${options.onTimeout()}`;
  throw new Error(`Timed out waiting for: ${options.label}${detail}`);
}
