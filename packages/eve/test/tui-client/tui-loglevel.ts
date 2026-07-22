import { Client } from "eve/client";
import {
  EveTUIRunner,
  MockScreen,
  MockUserInput,
  TerminalRenderer,
  type EveTUIRunnerOptions,
} from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof of the buffered `/loglevel` command. Logs are captured
 * regardless of the display mode, so switching modes applies retroactively:
 *
 *   - `/loglevel none` hides log lines already in the transcript
 *   - lines captured while hidden stay buffered, invisible
 *   - `/loglevel all` restores the streams: each source renders one
 *     section showing its NEWEST write, with earlier writes behind an
 *     `… (N more)` count (the diagnostics file carries the history)
 *
 * Needs no agent server and no model credentials.
 */
const UNREACHABLE_HOST = "http://127.0.0.1:49217";
const VISIBLE_STDOUT_MARK = "LOGLEVEL_STDOUT_MARK_4f2";
const VISIBLE_STDERR_MARK = "LOGLEVEL_STDERR_MARK_8d5";
const HIDDEN_STDOUT_MARK = "LOGLEVEL_HIDDEN_MARK_1a9";
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
  });
  const options: EveTUIRunnerOptions = { session: client.session(), client, renderer };
  const runner = new EveTUIRunner(options);

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  try {
    await screen.waitForIdlePrompt(5_000);

    // Foreign writes are captured synchronously, so snapshots reflect them
    // immediately.
    process.stdout.write(`${VISIBLE_STDOUT_MARK}\n`);
    process.stderr.write(`${VISIBLE_STDERR_MARK}\n`);
    const visible = screen.snapshot();
    if (!visible.includes(VISIBLE_STDOUT_MARK) || !visible.includes(VISIBLE_STDERR_MARK)) {
      throw new Error(`logs=all should show both streams before the toggle:\n${visible}`);
    }

    input.type("/loglevel none");
    input.enter();
    await screen.waitForText("Logs hidden", 5_000);

    const hidden = screen.snapshot();
    if (hidden.includes(VISIBLE_STDOUT_MARK) || hidden.includes(VISIBLE_STDERR_MARK)) {
      throw new Error(`/loglevel none should retroactively hide past logs:\n${hidden}`);
    }

    // Captured while hidden: buffered, never rendered.
    process.stdout.write(`${HIDDEN_STDOUT_MARK}\n`);
    if (screen.snapshot().includes(HIDDEN_STDOUT_MARK)) {
      throw new Error(`logs captured while hidden should not render:\n${screen.snapshot()}`);
    }

    input.type("/loglevel all");
    input.enter();
    await screen.waitForText("Showing all logs", 5_000);

    const restored = screen.snapshot();
    // The stdout section shows only its newest write (the one captured
    // while hidden); the earlier mark sits behind the elided count.
    if (!restored.includes(HIDDEN_STDOUT_MARK) || !restored.includes(VISIBLE_STDERR_MARK)) {
      throw new Error(`/loglevel all should restore each stream's newest write:\n${restored}`);
    }
    if (restored.includes(VISIBLE_STDOUT_MARK) || !restored.includes("(1 more)")) {
      throw new Error(`earlier writes should collapse behind the elided count:\n${restored}`);
    }

    input.type("/exit");
    input.enter();
    await runPromise;

    process.stdout.write(
      `${theme.muted("[tui-loglevel] buffered hide/restore with newest-write sections verified")}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${theme.danger("\n[tui] tui-loglevel smoke test failed:")} ${String(error)}\n`,
    );
    process.exitCode = 1;
  }
})();
