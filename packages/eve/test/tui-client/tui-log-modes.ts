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
 * End-to-end proof of the `--logs` modes. With capture forced on, a stdout
 * line from each source is emitted while the TUI sits at its prompt; what gets
 * rendered depends on the mode:
 *
 *   - `all`     → stdout, stderr, and sandbox render
 *   - `stderr`  → only stderr renders
 *   - `sandbox` → only sandbox renders
 *   - `none`    → none render (still buffered, never corrupt the frame)
 *
 * Needs no agent server and no model credentials.
 */
const UNREACHABLE_HOST = "http://127.0.0.1:49216";
const STDOUT_MARK = "STDOUT_LOG_MARK_7b3";
const STDERR_MARK = "STDERR_LOG_MARK_9c1";
const SANDBOX_MARK = "SANDBOX_LOG_MARK_6a2";
process.env.EVE_TUI_UNICODE = "1";

async function snapshotForMode(mode: "all" | "stderr" | "sandbox" | "none"): Promise<string> {
  const client = new Client({ host: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const renderer = new TerminalRenderer({
    input,
    output: screen,
    captureForeignOutput: true,
    logs: mode,
  });
  const options: EveTUIRunnerOptions = { session: client.session(), client, renderer };
  const runner = new EveTUIRunner(options);

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  await screen.waitForText("❯", 5_000);

  // Foreign writes are captured synchronously, so the snapshot reflects
  // them immediately.
  process.stdout.write(`${STDOUT_MARK}\n`);
  process.stderr.write(`${STDERR_MARK}\n`);
  process.stdout.write(`eve: sandbox ${SANDBOX_MARK}\n`);
  const snapshot = screen.snapshot();

  input.type("/exit");
  input.enter();
  await runPromise;

  return snapshot;
}

void (async () => {
  try {
    const all = await snapshotForMode("all");
    if (!all.includes(STDOUT_MARK) || !all.includes(STDERR_MARK) || !all.includes(SANDBOX_MARK)) {
      throw new Error(`logs=all should show every source:\n${all}`);
    }

    const stderrOnly = await snapshotForMode("stderr");
    if (
      stderrOnly.includes(STDOUT_MARK) ||
      !stderrOnly.includes(STDERR_MARK) ||
      stderrOnly.includes(SANDBOX_MARK)
    ) {
      throw new Error(`logs=stderr should show only stderr:\n${stderrOnly}`);
    }

    const sandboxOnly = await snapshotForMode("sandbox");
    if (
      sandboxOnly.includes(STDOUT_MARK) ||
      sandboxOnly.includes(STDERR_MARK) ||
      !sandboxOnly.includes(SANDBOX_MARK)
    ) {
      throw new Error(`logs=sandbox should show only sandbox lines:\n${sandboxOnly}`);
    }

    const none = await snapshotForMode("none");
    if (none.includes(STDOUT_MARK) || none.includes(STDERR_MARK) || none.includes(SANDBOX_MARK)) {
      throw new Error(`logs=none should hide every source:\n${none}`);
    }

    process.stdout.write(
      `${theme.muted("[tui-log-modes] all / stderr / sandbox / none modes verified")}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${theme.danger("\n[tui] tui-log-modes smoke test failed:")} ${String(error)}\n`,
    );
    process.exitCode = 1;
  }
})();
