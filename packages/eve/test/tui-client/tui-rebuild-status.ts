import { Client } from "eve/client";
import {
  AUTHORED_ARTIFACTS_UPDATED_LOG_LINE,
  EveTUIRunner,
  formatChangeDetectedLogLine,
  MockScreen,
  MockUserInput,
  TerminalRenderer,
  type EveTUIRunnerOptions,
} from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof that the dev server's rebuild log lines cycle through a
 * single in-place status row instead of stacking. Lines come from the
 * watcher's real formatter, so this exercises the producer/parser contract:
 *
 *   - repeated change→updated cycles show only the latest state
 *   - changed paths shrink to their last two components
 *   - the raw `[eve:dev] change detected …` lines never reach the transcript
 *
 * Needs no agent server and no model credentials.
 */
const UNREACHABLE_HOST = "http://127.0.0.1:49217";
const APP_ROOT = "/tmp/rebuild-status-app";
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
    await screen.waitForText("❯", 5_000);

    // Two full rebuild cycles, producer-authentic lines. Foreign writes are
    // captured synchronously, so snapshots reflect them immediately.
    process.stdout.write(
      `${formatChangeDetectedLogLine(APP_ROOT, [
        { event: "change", path: `${APP_ROOT}/agent/agent.ts` },
      ])}\n`,
    );
    process.stdout.write(`${AUTHORED_ARTIFACTS_UPDATED_LOG_LINE}\n`);
    process.stdout.write(
      `${formatChangeDetectedLogLine(APP_ROOT, [
        { event: "change", path: "/elsewhere/src/cli/dev/tui/setup-panel.ts" },
      ])}\n`,
    );
    process.stdout.write(`${AUTHORED_ARTIFACTS_UPDATED_LOG_LINE}\n`);

    const snapshot = screen.snapshot();
    if (!snapshot.includes("tui/setup-panel.ts changed · rebuilt")) {
      throw new Error(`the latest rebuild should show condensed and in place:\n${snapshot}`);
    }
    if (snapshot.includes("agent/agent.ts")) {
      throw new Error(`the earlier rebuild cycle should be replaced, not stacked:\n${snapshot}`);
    }
    if (snapshot.includes("change detected") || snapshot.includes("/elsewhere/src")) {
      throw new Error(`raw rebuild lines and full paths should not render:\n${snapshot}`);
    }

    input.type("/exit");
    input.enter();
    await runPromise;

    process.stdout.write(
      `${theme.muted("[tui-rebuild-status] in-place rebuild status with shortened paths verified")}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${theme.danger("\n[tui] tui-rebuild-status smoke test failed:")} ${String(error)}\n`,
    );
    process.exitCode = 1;
  }
})();
