import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "eve/client";
import {
  createPromptCommandHandler,
  EveTUIRunner,
  MockScreen,
  MockUserInput,
  promptCommandsFor,
} from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof of the TUI prompt commands.
 *
 *   1. A turn against an unreachable server renders an error region.
 *   2. `/new` clears the transcript and starts a fresh session, the error
 *      region disappears and the screen returns to the empty prompt.
 *   3. `/deploy` (in a remote command context) renders the local-only notice
 *      instead of suspending into a setup flow.
 *   4. `/exit` terminates the runner, exactly as Ctrl+C would.
 *   5. Local `/channels` opens the real setup picker, Escape cancels it, and
 *      the TUI returns to the prompt.
 *
 * Needs no agent server and no model credentials.
 */
const UNREACHABLE_HOST = "http://127.0.0.1:49214";
process.env.EVE_TUI_UNICODE = "1";

void (async () => {
  const client = new Client({ host: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session: client.session(),
    client,
    screen,
    userInput: input,
    name: "TUI slash commands",
    availablePromptCommands: promptCommandsFor("remote"),
    promptCommandHandler: createPromptCommandHandler({
      target: {
        kind: "remote",
        serverUrl: UNREACHABLE_HOST,
        workspaceRoot: process.cwd(),
      },
    }),
  });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  try {
    await screen.waitForText("❯", 5_000);

    input.type("boom");
    input.enter();
    await screen.waitForText("Error", 10_000);
    console.log(theme.muted("[tui-slash-commands] error region rendered"));

    // Wait until `readPrompt` is active again so the next keystrokes
    // aren't dropped in the gap between turns.
    await screen.waitForText("❯", 5_000);
    input.type("/new");
    input.enter();
    await screen.waitForText("❯", 5_000);
    if (screen.snapshot().includes("Error")) {
      throw new Error(`/new did not clear the transcript:\n${screen.snapshot()}`);
    }
    console.log(theme.muted("[tui-slash-commands] /new cleared the transcript"));

    // Remote setup commands return a local-only notice instead of opening a flow.
    input.type("/deploy");
    input.enter();
    await screen.waitForText("/deploy needs eve dev running the local server", 5_000);
    console.log(theme.muted("[tui-slash-commands] /deploy rendered the local-only notice"));

    await screen.waitForText("❯", 5_000);
    input.type("/exit");
    input.enter();

    // `/exit` must resolve `run()` on its own, no Ctrl+C needed.
    await withTimeout(runPromise, 5_000, "/exit did not terminate the runner");
    console.log(theme.muted("[tui-slash-commands] /exit terminated the TUI"));

    await runLocalChannelsCancellation();
  } catch (error) {
    input.ctrlC();
    await runPromise.catch(() => {});
    throw error;
  }
})().catch((error: unknown) => {
  console.error(theme.danger("\n[tui] tui-slash-commands smoke test failed:"), error);
  process.exitCode = 1;
});

async function runLocalChannelsCancellation(): Promise<void> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-tui-setup-"));
  const client = new Client({ host: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session: client.session(),
    client,
    screen,
    userInput: input,
    name: "TUI local setup",
    appRoot,
    availablePromptCommands: promptCommandsFor("local"),
    promptCommandHandler: createPromptCommandHandler({
      target: { kind: "local", serverUrl: UNREACHABLE_HOST, workspaceRoot: appRoot },
    }),
  });
  const runPromise = runner.run();

  try {
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await writeFile(join(appRoot, "agent/agent.ts"), "export default {};\n", "utf8");
    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify({ name: "tui-local-setup", private: true }, null, 2)}\n`,
      "utf8",
    );

    await screen.waitForText("❯", 5_000);
    input.type("/channels");
    input.enter();
    await screen.waitForText("Where will you chat with your agent?", 10_000);
    input.send("\x1b");
    await screen.waitForText("/channels cancelled.", 5_000);
    await screen.waitForText("❯", 5_000);
    console.log(theme.muted("[tui-slash-commands] local /channels cancelled back to prompt"));

    input.type("/exit");
    input.enter();
    await withTimeout(runPromise, 5_000, "local /exit did not terminate the runner");
  } catch (error) {
    input.ctrlC();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
