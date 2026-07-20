import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "eve/client";
import { createPromptCommandHandler, EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof of the TUI's persistent status line and its workspace-scoped
 * deploy state.
 *
 *   1. `/channels` adding a channel marks `deploy pending` on the line.
 *   2. `/new` clears the transcript but the pending flag survives — deploy
 *      state is workspace-scoped, not conversation-scoped.
 *   3. `/deploy` clears the pending marker.
 *   4. An unlinked directory renders no Vercel segment at all.
 *
 * The linked project identity is no longer a standalone status-line segment;
 * it folds into the model-endpoint segment (`via ai-gateway(oidc:project)`),
 * which only
 * renders for a reachable server that reports a gateway-routed model on
 * `/eve/v1/info`. That path is covered by the unit tests in `status-line.test.ts`
 * and the server-backed evals — not here, where the host is unreachable.
 *
 * Setup flows are injected fakes; the identity probe runs for real against a
 * temp dir with no `.vercel/project.json`. Needs no agent server, no `vercel`
 * CLI, and no credentials.
 */
const UNREACHABLE_HOST = "http://127.0.0.1:49215";
process.env.EVE_TUI_UNICODE = "1";

void (async () => {
  await runPendingDeployCycle();
  await runUnlinkedShowsNoVercelSegment();
})().catch((error: unknown) => {
  console.error(theme.danger("\n[tui] tui-status-line smoke test failed:"), error);
  process.exitCode = 1;
});

async function runPendingDeployCycle(): Promise<void> {
  const appRoot = await makeAppRoot();
  const client = new Client({ host: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session: client.session(),
    client,
    screen,
    userInput: input,
    name: "TUI status line",
    appRoot,
    serverUrl: UNREACHABLE_HOST,
    promptCommandHandler: createPromptCommandHandler({
      target: { kind: "local", serverUrl: UNREACHABLE_HOST, workspaceRoot: appRoot },
      flows: {
        runChannelsFlow: async () => ({ kind: "done", addedChannels: ["slack"] }),
        runDeployFlow: async () => ({ kind: "deployed" }),
      },
    }),
  });
  const runPromise = runner.run();

  try {
    await screen.waitForIdlePrompt(5_000);
    await screen.waitForText(` :${new URL(UNREACHABLE_HOST).port} `, 5_000);
    console.log(theme.muted("[tui-status-line] local loopback badge rendered"));

    input.type("/channels");
    input.enter();
    await screen.waitForText("Channels added: slack", 5_000);
    await screen.waitForText("deploy pending", 5_000);
    console.log(theme.muted("[tui-status-line] /channels marked the deploy pending"));

    input.type("/new");
    input.enter();
    await screen.waitForIdlePrompt(5_000);
    if (!screen.snapshot().includes("deploy pending")) {
      throw new Error(`/new dropped the pending-deploy flag:\n${screen.snapshot()}`);
    }
    console.log(theme.muted("[tui-status-line] pending flag survived /new"));

    input.type("/deploy");
    input.enter();
    await screen.waitForText("Deployed.", 5_000);
    await waitForGone(screen, "deploy pending", 5_000);
    console.log(theme.muted("[tui-status-line] /deploy cleared the pending flag"));

    input.type("/exit");
    input.enter();
    await withTimeout(runPromise, 5_000, "/exit did not terminate the runner");
  } catch (error) {
    input.ctrlC();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
}

async function runUnlinkedShowsNoVercelSegment(): Promise<void> {
  const appRoot = await makeAppRoot();
  const client = new Client({ host: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  // No detectProjectIdentity injection: the real probe reads the temp dir's
  // missing `.vercel/project.json` and resolves unlinked without shelling out.
  const runner = new EveTUIRunner({
    session: client.session(),
    client,
    screen,
    userInput: input,
    name: "TUI status line unlinked",
    appRoot,
    serverUrl: UNREACHABLE_HOST,
    promptCommandHandler: createPromptCommandHandler({
      target: { kind: "local", serverUrl: UNREACHABLE_HOST, workspaceRoot: appRoot },
    }),
  });
  const runPromise = runner.run();

  try {
    await screen.waitForIdlePrompt(5_000);
    // Allow the unlinked probe to land and repaint before judging the footer.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const lines = screen.snapshot().split("\n");
    const promptRow = lines.findLastIndex((line) => line.includes("›"));
    const footer = lines.slice(promptRow + 1).join("\n");
    if (footer.includes("▲")) {
      throw new Error(`unlinked footer rendered a Vercel segment:\n${screen.snapshot()}`);
    }
    console.log(theme.muted("[tui-status-line] unlinked session shows no Vercel segment"));

    input.type("/exit");
    input.enter();
    await withTimeout(runPromise, 5_000, "unlinked /exit did not terminate the runner");
  } catch (error) {
    input.ctrlC();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
}

async function makeAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-tui-status-"));
  await mkdir(join(appRoot, "agent"), { recursive: true });
  await writeFile(join(appRoot, "agent/agent.ts"), "export default {};\n", "utf8");
  await writeFile(
    join(appRoot, "package.json"),
    `${JSON.stringify({ name: "tui-status-line", private: true }, null, 2)}\n`,
    "utf8",
  );
  return appRoot;
}

async function waitForGone(screen: MockScreen, text: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (screen.snapshot().includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for screen text to clear: ${text}\n\n${screen.snapshot()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
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
