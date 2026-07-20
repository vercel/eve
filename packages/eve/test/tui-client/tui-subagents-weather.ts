import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { run, type RunOptions } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/**
 * Multi-message subagent smoke driving `e2e/fixtures/agent-subagents-hitl` and its
 * `stock-price` subagent. The subagent emits a pre-tool message
 * ("I'll look up..."), calls `get_stock_price` (which has
 * `approval: once()`), and then emits a post-tool message
 * with the result. This is the real-world flow that broke the earlier
 * stepIndex-keyed implementation, both pre and post messages were
 * landing under `stepIndex: 0` and collapsing into one box.
 *
 * Pass conditions:
 *   1. A `※ subagent(stock-price…)` region header exists.
 *   2. The child's `get_stock_price` tool row renders nested inside the
 *      subagent's `│` rule gutter (proves the child tool surfaces under
 *      the subagent flow).
 *   3. NO parent-level `get_stock_price` tool row exists (proves the
 *      parent-tool suppression for child tool calls removes the stale
 *      block, not just blocks future renders).
 *   4. The price (178.92) appears inside the nested subagent region —
 *      or the section already settled to its `└ Done` footnote (a
 *      completed subagent collapses, so nested rows are transient).
 *   5. The parent's final assistant reply (a top-level `▲` section)
 *      also contains the price.
 */

const TICKER = "GOOG";
const PRICE = "178.92";
process.env.EVE_TUI_UNICODE = "1";

const WEATHER_SMOKE_TARGET: RunOptions = {
  app: "agent-subagents-hitl",
  kind: "local-build",
  // The spawned server must use the deterministic authored-model adapter;
  // otherwise this TUI rendering smoke depends on an AI Gateway credential.
  startEnv: { ...process.env, EVE_MOCK_AUTHORED_MODELS: "1" },
};

run(WEATHER_SMOKE_TARGET, async (target) => {
  const client = new Client({ host: target.baseUrl });
  const session = client.session();
  const screen = new MockScreen({ columns: 140, rows: 60 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session,
    client,
    screen,
    userInput: input,
    name: "Weather subagent smoke",
  });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  await screen.waitForIdlePrompt(5_000);

  // Delegate explicitly. An implicit prompt ("what is the value of GOOG?")
  // leaves the choice to the model, which may answer directly instead of
  // delegating. Explicitly limiting the request to one delegation also keeps
  // the model from re-checking the fixed fixture result with a second child.
  input.type(
    `Call the stock-price subagent exactly once with message 'Call the get_stock_price tool exactly once with ticker "${TICKER}". After it returns, do not call any tool again; return the result.'. After that single subagent call finishes, do not call any subagent or tool again; include the exact stock price in your final reply.`,
  );
  input.enter();

  // The subagent region header should appear once the parent delegates.
  await waitForCondition(() => screen.snapshot().includes("※ subagent(stock-price"), {
    timeoutMs: 120_000,
    label: "subagent region header",
    onTimeout: () => screen.snapshot(),
  });
  console.log(theme.muted("[tui-weather] subagent region header appeared"));

  // Approve the get_stock_price tool when prompted. The TUI parks on a
  // y/n approval prompt, match the question smoke's handshake delay
  // so the server's resume hook is registered before we reply.
  await waitForCondition(
    () =>
      screen.snapshot().includes("Approve get_stock_price?") ||
      screen.snapshot().includes("Approve get stock price?"),
    {
      timeoutMs: 120_000,
      label: "approval prompt for get_stock_price",
      onTimeout: () => screen.snapshot(),
    },
  );
  await sleep(500);
  input.emit("data", Buffer.from("y"));
  console.log(theme.muted("[tui-weather] approved get_stock_price"));

  // Price should appear in the body once the child unblocks.
  await waitForCondition(() => screen.snapshot().includes(PRICE), {
    timeoutMs: 120_000,
    label: `price ${PRICE} renders in the body`,
    onTimeout: () => screen.snapshot(),
  });
  console.log(theme.muted(`[tui-weather] price ${PRICE} landed in body`));

  // The child's tool row renders nested inside the subagent's `│` rule
  // gutter — unless the section already settled and collapsed past it.
  await waitForCondition(
    () =>
      /│.*get_stock_price/u.test(screen.snapshot()) ||
      screen
        .snapshot()
        .split("\n")
        .some((line) => line.includes("└") && line.includes("Done")),
    {
      timeoutMs: 60_000,
      label: "nested subagent tool row (or the section settled)",
      onTimeout: () => screen.snapshot(),
    },
  );
  console.log(theme.muted("[tui-weather] nested subagent tool row rendered (or settled)"));

  // The price renders inside the nested subagent region (tool result or
  // post-tool message) while the child is still live — but a settled child
  // collapses its section to the `└ Done…` footnote, so losing that race
  // must not fail the smoke. Child-side delivery was already proven by the
  // body wait above; the parent-echo wait below proves the full round trip.
  await waitForCondition(
    () =>
      screen
        .snapshot()
        .split("\n")
        .some(
          // The nested price row can carry either rail glyph — the `└`
          // corner when it is the section's last row (the rail closes on
          // the newest child), `│` otherwise — and a fully settled
          // section shows the `└ Done…` footnote instead.
          (line) =>
            ((line.includes("│") || line.includes("└")) && line.includes(PRICE)) ||
            (line.includes("└") && line.includes("Done")),
        ),
    {
      timeoutMs: 120_000,
      label: `price ${PRICE} inside the nested subagent region (or the section settled)`,
      onTimeout: () => screen.snapshot(),
    },
  );
  console.log(theme.muted("[tui-weather] subagent region carried the price or settled to Done"));

  // Wait for the parent's follow-up assistant section (top-level `▲`
  // prose, not nested under the rule gutter) to echo the price.
  await waitForCondition(() => assistantSectionContains(screen.snapshot(), PRICE), {
    timeoutMs: 120_000,
    label: "parent assistant reply with price",
    onTimeout: () => screen.snapshot(),
  });

  const finalSnapshot = screen.snapshot();

  // No parent-level tool row for the child's call should remain: a tool
  // row at the parent level is a status glyph in the indented header cell
  // (e.g. `  ▪ get_stock_price`), while the legitimate one is prefixed by
  // the subagent's `│` rule. Assistant prose lines start with `▲ `, so
  // they cannot false-positive here.
  const parentToolRowRegex = /^ {0,2}[^\s│▲] get_stock_price/mu;
  if (parentToolRowRegex.test(finalSnapshot)) {
    throw new Error(
      `Final screen still contains a parent-level tool row for the child's get_stock_price call. The nested subagent region should be the only place it appears.\n\n${finalSnapshot}`,
    );
  }
  console.log(theme.muted("[tui-weather] no stale parent-level get_stock_price tool row"));

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
  const extra = options.onTimeout?.() ?? "";
  throw new Error(`Timed out waiting for: ${options.label}${extra ? `\n\n${extra}` : ""}`);
}
