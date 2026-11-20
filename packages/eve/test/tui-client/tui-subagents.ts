import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { run } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

const SUBAGENT_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
process.env.EVE_TUI_UNICODE = "1";

run({ app: "agent-tui-client", kind: "local-build" }, async (target) => {
  const client = new Client({ baseUrl: target.baseUrl });
  const screen = new MockScreen({ columns: 120, rows: 50 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
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

  await screen.waitForText("Delegate subagent(echo marker)", 90_000);
  console.log(theme.muted("[tui-subagents] task start line appeared"));

  await screen.waitForText("✓ subagent(echo marker)", 90_000);
  console.log(theme.muted("[tui-subagents] task end line appeared"));

  await waitForCondition(() => assistantSectionContains(screen.snapshot(), SUBAGENT_TOKEN), {
    timeoutMs: 120_000,
    label: "parent assistant section containing the token",
    onTimeout: () => screen.snapshot(),
  });
  console.log(theme.muted("[tui-subagents] parent assistant reply rendered with token"));

  const finalSnapshot = screen.snapshot();
  for (const internal of ["eve__task_wait", "eve__task_cancel", "<task_result"]) {
    if (finalSnapshot.includes(internal)) {
      throw new Error(`Final screen shows internal task text "${internal}":\n${finalSnapshot}`);
    }
  }
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
  const detail = options.onTimeout === undefined ? "" : `\n${options.onTimeout()}`;
  throw new Error(`Timed out waiting for: ${options.label}${detail}`);
}
