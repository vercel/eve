import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput, TerminalRenderer } from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof that foreign `process.stderr` / `process.stdout` output
 * from in-process code (the dev server or agent calling `console.warn`,
 * etc.) is captured and rendered as an inline `Log` region instead of
 * corrupting the alt-screen frame, and that a log landing mid-turn does
 * not cause the submitted prompt to be echoed as a second `User` region.
 *
 * Reproduces the reported failure modes without an agent server or model
 * credentials: capture is forced on for the injected mock screen, the turn
 * targets an unreachable server (so it fails fast), and a `console.warn`
 * fires right after the prompt is submitted, exactly when the in-process
 * server emits its diagnostics.
 */
const UNREACHABLE_HOST = "http://127.0.0.1:49215";
const WARNING = "SIMULATED_SERVER_WARNING_4f2a";
const PROMPT = "what can you do for me?";
process.env.EVE_TUI_UNICODE = "1";

void (async () => {
  const client = new Client({ host: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const renderer = new TerminalRenderer({
    input,
    output: screen,
    captureForeignOutput: true,
    logs: "all",
    unicode: true,
  });
  const runner = new EveTUIRunner({ session: client.session(), client, renderer });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  try {
    await screen.waitForIdlePrompt(5_000);

    // Submit a prompt, then emit a foreign stderr write before the turn
    // renders, the order the in-process server produces it in.
    input.type(PROMPT);
    input.enter();
    console.warn(WARNING);

    await screen.waitForText("○ stderr", 5_000);
    await screen.waitForText(WARNING, 5_000);

    // The warning must ride the section's rail, not shred the prompt.
    const snapshot = screen.snapshot();
    if (
      !snapshot
        .split("\n")
        .some((line) => line.includes(WARNING) && line.trimStart().startsWith("│"))
    ) {
      throw new Error(`warning was not rendered in the server-log lane:\n${snapshot}`);
    }

    // The turn fails (unreachable) and renders an Error region. The
    // submitted prompt must appear exactly once despite the log region
    // landing between the echo and the turn render.
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
