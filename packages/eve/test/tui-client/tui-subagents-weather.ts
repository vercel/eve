import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { run, type RunOptions } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

const TICKER = "GOOG";
const PRICE = "178.92";
process.env.EVE_TUI_UNICODE = "1";

const WEATHER_SMOKE_TARGET: RunOptions = {
  app: "agent-subagents-hitl",
  kind: "local-build",
  startEnv: { ...process.env, EVE_E2E_MODEL: "mock" },
};

run(WEATHER_SMOKE_TARGET, async (target) => {
  const client = new Client({ baseUrl: target.baseUrl });
  const screen = new MockScreen({ columns: 140, rows: 60 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
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

  input.type(
    `Call the stock-price subagent exactly once with message 'Call the get_stock_price tool exactly once with ticker "${TICKER}". After it returns, do not call any tool again; return the result.'. After that single subagent call finishes, do not call any subagent or tool again; include the exact stock price in your final reply.`,
  );
  input.enter();

  await waitForCondition(() => screen.snapshot().includes("Delegate subagent(stock price)"), {
    timeoutMs: 120_000,
    label: "task start line",
    onTimeout: () => screen.snapshot(),
  });
  console.log(theme.muted("[tui-weather] task start line appeared"));

  await waitForCondition(() => screen.snapshot().includes("Approve Get stock price?"), {
    timeoutMs: 120_000,
    label: "approval prompt for get_stock_price",
    onTimeout: () => screen.snapshot(),
  });
  await sleep(500);
  input.emit("data", Buffer.from("y"));
  console.log(theme.muted("[tui-weather] approved get_stock_price"));

  await waitForCondition(() => screen.snapshot().includes("✓ subagent(stock price)"), {
    timeoutMs: 120_000,
    label: "task end line",
    onTimeout: () => screen.snapshot(),
  });
  console.log(theme.muted("[tui-weather] task end line appeared"));

  await waitForCondition(() => assistantSectionContains(screen.snapshot(), PRICE), {
    timeoutMs: 120_000,
    label: "parent assistant reply with price",
    onTimeout: () => screen.snapshot(),
  });

  const finalSnapshot = screen.snapshot();

  const parentToolRowRegex = /^ {0,2}[^\s▲] get_stock_price/mu;
  if (parentToolRowRegex.test(finalSnapshot)) {
    throw new Error(
      `Final screen still contains a parent-level tool row for the child's get_stock_price call. The child's calls belong to its task, not the parent transcript.\n\n${finalSnapshot}`,
    );
  }
  console.log(theme.muted("[tui-weather] no stale parent-level get_stock_price tool row"));

  if (finalSnapshot.includes("Error")) {
    throw new Error(`Final screen contains an Error section:\n${finalSnapshot}`);
  }

  await screen.waitForIdlePrompt(30_000);
  input.ctrlC();
  input.ctrlC();
  await runPromise;
});

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
