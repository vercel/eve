import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnInPseudoTerminal } from "./lib/pty.ts";
import { theme } from "./lib/theme.ts";
import { MockScreen } from "./lib/tui.ts";

/**
 * End-to-end check of what a person sees during `eve init <name>` in a real
 * terminal, from the first progress row to `eve dev`'s chat prompt.
 *
 * Runs the built CLI in a pseudo-terminal against a packed eve, so the
 * scaffold really installs and `eve init` really hands the terminal to the
 * project's own `eve dev`. Every screen the terminal could have shown is
 * replayed (a synchronized update counts once, at its end) and checked, so a
 * screen that blanks, flashes a premature state, or paints twice fails the
 * test even when the final screen looks right.
 *
 * Regression: eve 1.0.1 erased init's onboarding screen when the install
 * finished, printed "Created an eve agent", and showed a "Starting your agent"
 * row while `eve dev` loaded, so the agent's screen appeared, vanished, and
 * came back. Printing that summary above a kept screen instead pushed the
 * screen down, so the header must also stay on one row throughout.
 *
 * Needs no agent server and no model credentials: onboarding is skipped with
 * Escape. Network: the scaffold's install resolves eve's declared dependencies
 * from the registry.
 */
const root = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(root, "..", "..");
const COLUMNS = 100;
const ROWS = 30;
const STARTUP_HEADER = /Run \/help for commands/u;
const STATUS_LABELS = [
  "Installing dependencies…",
  "Starting agent…",
  "Reading saved connection…",
] as const;
/** Environment variables that make eve treat the launch as a coding agent's, not a person's. */
const AGENT_ENV = [
  "AI_AGENT",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_IS_COWORK",
  "CODEX_CI",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
  "COPILOT_MODEL",
  "CURSOR_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "CURSOR_TRACE_ID",
  "GEMINI_CLI",
  "OPENCODE",
  "OPENCODE_CLIENT",
  "REPL_ID",
];

void (async () => {
  const workRoot = await mkdtemp(join(tmpdir(), "eve-tui-init-"));
  try {
    const tarballPath = join(workRoot, "eve.tgz");
    // `test:tui` already built the package; packing must stay faithful to that build.
    await exec("pnpm", ["pack", "--config.ignore-scripts=true", "--out", tarballPath], packageRoot);
    console.log(theme.muted("[tui-init-handoff] packed eve tarball"));

    const home = join(workRoot, "home");
    await mkdir(home);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      TERM: "xterm-256color",
      EVE_TUI_UNICODE: "1",
      EVE_TELEMETRY_DISABLED: "1",
      EVE_INIT_PACKAGE_SPEC: `file:${tarballPath}`,
      // Scaffold with pnpm, as `pnx eve init` does.
      npm_config_user_agent: "pnpm/12.0.0 npm/? node/v26.0.0 linux x64",
      GIT_AUTHOR_NAME: "Alice",
      GIT_AUTHOR_EMAIL: "alice@example.com",
      GIT_COMMITTER_NAME: "Alice",
      GIT_COMMITTER_EMAIL: "alice@example.com",
    };
    // A person's terminal: no CI, no coding agent, no model credentials to discover.
    for (const key of [
      ...AGENT_ENV,
      "CI",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AI_GATEWAY_API_KEY",
      "VERCEL_OIDC_TOKEN",
      "VERCEL_TOKEN",
    ]) {
      delete env[key];
    }

    const screen = new MockScreen({ columns: COLUMNS, rows: ROWS });
    const terminal = spawnInPseudoTerminal({
      command: process.execPath,
      args: [join(packageRoot, "bin/eve.js"), "init", "demo"],
      cwd: workRoot,
      env,
      columns: COLUMNS,
      rows: ROWS,
    });
    terminal.onData((chunk) => screen.write(chunk));

    let framesBeforeExit: readonly string[] = [];
    try {
      await screen.waitForText("Anthropic API Key", 120_000);
      console.log(theme.muted("[tui-init-handoff] onboarding opened during the install"));
      terminal.write("\x1b");

      await waitForChatPrompt(screen, 120_000);
      console.log(theme.muted("[tui-init-handoff] eve dev reached its chat prompt"));
      framesBeforeExit = [...screen.frames()];

      terminal.write("/exit\r");
      const code = await withTimeout(terminal.exited, 30_000, "eve did not exit after /exit");
      if (code !== 0) throw new Error(`eve init exited with ${code}.`);
    } catch (error) {
      console.error(`[tui-init-handoff] screen at failure:\n${screen.snapshot()}`);
      terminal.kill();
      throw error;
    }

    assertSmoothJourney(framesBeforeExit, workRoot);
    console.log(theme.muted(`[tui-init-handoff] OK (${framesBeforeExit.length} screens checked)`));
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

function assertSmoothJourney(frames: readonly string[], workRoot: string): void {
  const firstScreen = frames.findIndex((frame) => STARTUP_HEADER.test(frame));
  check(firstScreen >= 0, "The agent's screen never appeared.", frames, 0);

  // Init's progress row stays until the agent's screen paints over it.
  const firstRow = frames.findIndex((frame) => frame.includes("Creating agent"));
  for (let index = Math.max(firstRow, 0); firstRow >= 0 && index < firstScreen; index += 1) {
    check(
      frames[index]!.includes("Creating agent"),
      "The screen went blank between init's progress row and the agent's screen.",
      frames,
      index,
    );
  }

  const headerRow = (frame: string) =>
    frame.split("\n").findIndex((line) => STARTUP_HEADER.test(line));
  let lastStatus = -1;
  for (let index = firstScreen; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const visible = frame.split("\n").slice(-ROWS);
    check(
      headerRow(frame) === headerRow(frames[firstScreen]!),
      "The agent's header moved.",
      frames,
      index,
    );
    check(
      visible.some((line) => STARTUP_HEADER.test(line)),
      "The agent's screen disappeared before eve dev's chat prompt.",
      frames,
      index,
    );
    check(
      frame.split("\n").filter((line) => STARTUP_HEADER.test(line)).length === 1,
      "The agent's header was painted twice.",
      frames,
      index,
    );
    check(
      !/^\s*· Ready\b/mu.test(frame),
      'A prompt-less "Ready" screen flashed as if the agent were up.',
      frames,
      index,
    );
    check(
      !/(Creating agent|Installing dependencies\.\.\.|Initializing Git|Starting your agent)/u.test(
        frame,
      ),
      "A progress row flashed over the agent's screen.",
      frames,
      index,
    );
    const status = STATUS_LABELS.findIndex((label) =>
      visible.some((line) => line.trim().endsWith(label)),
    );
    if (status >= 0) {
      check(
        status >= lastStatus,
        `The status went back to "${STATUS_LABELS[status]}" after "${STATUS_LABELS[lastStatus]}".`,
        frames,
        index,
      );
      lastStatus = status;
    }
  }
  check(
    frames[firstScreen]!.includes(STATUS_LABELS[0]),
    "The agent's screen opened on something other than the install.",
    frames,
    firstScreen,
  );

  const final = frames.at(-1)!;
  const created = `✓ Created an eve agent in ${join(workRoot, "demo")}`;
  check(
    final.split(created).length === 2,
    `Expected one "${created}" line.`,
    frames,
    frames.length - 1,
  );
  check(
    final.indexOf(created) < final.search(STARTUP_HEADER),
    "The summary is not above the agent's screen.",
    frames,
    frames.length - 1,
  );
  check(
    /setup issue: .*\/login/u.test(final),
    "The skipped connection was not pointed at /login.",
    frames,
    frames.length - 1,
  );
}

function check(condition: boolean, message: string, frames: readonly string[], index: number) {
  if (condition) return;
  const context = frames
    .slice(Math.max(0, index - 1), index + 2)
    .map((frame, offset) => {
      const position = Math.max(0, index - 1) + offset;
      const lines = frame.split("\n").slice(-ROWS).join("\n");
      return `--- screen ${position}${position === index ? " (failing)" : ""} ---\n${lines}`;
    })
    .join("\n");
  throw new Error(`${message}\n\n${context}`);
}

/** Waits for eve dev's settled chat prompt: its agent header, the composer, and no startup status. */
async function waitForChatPrompt(
  screen: InstanceType<typeof MockScreen>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let settledSince: number | undefined;
  let frames = -1;
  while (true) {
    const snapshot = screen.snapshot();
    const ready =
      /· demo · Run \/help for commands/u.test(snapshot) &&
      /^❯/mu.test(snapshot) &&
      !STATUS_LABELS.some((label) => snapshot.includes(label));
    if (!ready || screen.frames().length !== frames) settledSince = undefined;
    else settledSince ??= Date.now();
    frames = screen.frames().length;
    if (settledSince !== undefined && Date.now() - settledSince >= 1_000) return;
    if (Date.now() > deadline) {
      throw new Error(`eve dev never reached its chat prompt.\n\nScreen:\n${snapshot}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

/** Runs a command to completion, failing loudly with its combined output. */
function exec(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${command} ${args.join(" ")} exited with ${code ?? "signal"}:\n${output}`),
      );
    });
  });
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
