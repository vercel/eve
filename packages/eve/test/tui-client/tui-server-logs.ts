import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput, TerminalRenderer } from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

const UNREACHABLE_HOST = "http://127.0.0.1:49215";
const WARNING = "SIMULATED_SERVER_WARNING_4f2a";
const PROMPT = "what can you do for me?";
process.env.EVE_TUI_UNICODE = "1";

void (async () => {
  const client = new Client({ baseUrl: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const renderer = new TerminalRenderer({
    input,
    output: screen,
    captureForeignOutput: true,
    logs: "all",
    unicode: true,
  });
  const runner = new EveTUIRunner({ client, renderer });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  try {
    await screen.waitForIdlePrompt(5_000);

    input.type(PROMPT);
    input.enter();
    console.warn(WARNING);

    await screen.waitForText("○ warn", 5_000);
    await screen.waitForText(WARNING, 5_000);

    const snapshot = screen.snapshot();
    if (
      !snapshot
        .split("\n")
        .some((line) => line.includes(WARNING) && line.trimStart().startsWith("│"))
    ) {
      throw new Error(`warning was not rendered in the server-log lane:\n${snapshot}`);
    }

    await screen.waitForText("Error", 10_000);
    const userPrompts = countOccurrences(screen.snapshot(), PROMPT);
    if (userPrompts !== 1) {
      throw new Error(
        `expected exactly one submitted prompt, found ${userPrompts}:\n${screen.snapshot()}`,
      );
    }

    await screen.waitForIdlePrompt(5_000);
    input.type("/exit");
    input.enter();
    await runPromise;

    process.stdout.write(
      `${theme.muted("[tui-server-logs] log region rendered, single user region")}\n`,
    );
  } catch (error) {
    input.ctrlC();
    input.ctrlC();
    await runPromise.catch(() => {});
    throw error;
  }
})().catch((error: unknown) => {
  process.stdout.write(
    `${theme.danger("\n[tui] tui-server-logs smoke test failed:")} ${String(error)}\n`,
  );
  process.exitCode = 1;
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) return count;
    count += 1;
    index = next + needle.length;
  }
}
