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
 *   4. Wait for the `◆ echo-marker subagent` region header to appear.
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

  await screen.waitForText("❯", 5_000);

  input.type(
    "Use the echo marker subagent to process the input 'ping'. Once it returns, reply with the subagent's exact output included verbatim in your message.",
  );
  input.enter();

  await screen.waitForText("echo-marker subagent", 90_000);
  console.log(theme.muted("[tui-subagents] subagent region header appeared"));

  await waitForCondition(() => screen.snapshot().includes(SUBAGENT_TOKEN), {
    timeoutMs: 90_000,
    label: "subagent message text landed in body",
  });
  console.log(theme.muted("[tui-subagents] subagent message text landed in body"));

  // Wait for the token to appear twice, once inside the subagent step
  // section, once in the parent's follow-up Assistant reply. This is the
  // proof that (a) the child stream subscription rendered the subagent's
  // output, and (b) the parent's verbatim echo flowed through after.
  await waitForCondition(() => countOccurrences(screen.snapshot(), SUBAGENT_TOKEN) >= 2, {
    timeoutMs: 120_000,
    label: "token rendered in both subagent + parent",
  });
  console.log(theme.muted("[tui-subagents] token rendered in subagent step + parent assistant"));

  // The parent's own reply must carry the token inside a top-level
  // `▲`-prefixed assistant section — not just inside the nested `│`
  // subagent region. Whether the model also emits a pre-delegation
  // message is model-dependent, so the section count is not asserted.
  await waitForCondition(() => assistantSectionContains(screen.snapshot(), SUBAGENT_TOKEN), {
    timeoutMs: 30_000,
    label: "parent assistant section containing the token",
  });
  console.log(theme.muted("[tui-subagents] parent assistant reply rendered with token"));

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

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) return count;
    count += 1;
    index = next + needle.length;
  }
}

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
