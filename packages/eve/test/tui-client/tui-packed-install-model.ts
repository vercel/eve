import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof that the *packed* eve artifact can open onboarding `/model`
 * after a consumer-shaped install.
 *
 * Every other smoke test resolves eve's modules inside the workspace, where
 * devDependencies are installed — so a runtime import of an undeclared
 * dependency still resolves and the bug ships. This test packs the built
 * package (`pnpm pack`), installs the tarball into an empty project with npm
 * (which installs only declared dependencies, exactly like a user install),
 * and drives the installed TUI through the prefilled onboarding provider setup.
 *
 * Regression: eve 0.6.x–0.7.0 imported `oxc-parser` from the `/model` flow
 * while declaring it only as a devDependency. In a scaffolded project the
 * import threw `ERR_MODULE_NOT_FOUND`, which crashed `eve dev` with a silent
 * non-zero exit. This test fails at the harness import or at the menu wait
 * when any runtime dependency of the dist tree is missing from the packed
 * manifest's `dependencies`.
 *
 * Needs no agent server and no model credentials. Network: the consumer
 * `npm install` resolves eve's declared dependencies from the registry.
 */
const root = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(root, "..", "..");

process.env.EVE_TUI_UNICODE = "1";

/** The harness surface this test uses from the installed package's dist. */
interface PackedTuiHarness {
  EveTUIRunner: new (options: Record<string, unknown>) => { run(): Promise<void> };
  MockScreen: new (size: { columns: number; rows: number }) => {
    waitForText(text: string, timeoutMs: number): Promise<unknown>;
    waitForIdlePrompt(timeoutMs: number): Promise<unknown>;
    snapshot(): string;
  };
  MockUserInput: new () => {
    type(text: string): void;
    enter(): void;
    send(sequence: string): void;
    ctrlC(): void;
  };
  createPromptCommandHandler: (options: {
    target: { kind: "local"; serverUrl: string; workspaceRoot: string };
  }) => unknown;
}

void (async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), "eve-packed-install-"));
  try {
    const tarballPath = join(consumerRoot, "eve.tgz");

    // `--config.ignore-scripts=true` skips `prepack` (a full rebuild): the
    // `test:tui` script already built `dist`, and packing must stay faithful
    // to it. pnpm still resolves `catalog:` ranges in the packed manifest.
    await exec("pnpm", ["pack", "--config.ignore-scripts=true", "--out", tarballPath], packageRoot);
    console.log(theme.muted("[tui-packed-install] packed eve tarball"));

    await writeFile(
      join(consumerRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "eve-packed-install-consumer",
          private: true,
          type: "module",
          dependencies: { eve: `file:${tarballPath}` },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    // `--min-release-age=0` matches eve's own scaffold install (the packed
    // manifest pins dependency versions younger than typical release-age
    // cooldown windows).
    await exec(
      "npm",
      ["install", "--min-release-age=0", "--no-audit", "--no-fund", "--loglevel=error"],
      consumerRoot,
    );
    console.log(theme.muted("[tui-packed-install] consumer npm install completed"));

    // Imported by file URL: the harness is not on the package's `exports`
    // map, and the point is to load the *installed* module graph — every
    // bare specifier in it resolves against the consumer's node_modules.
    const harnessPath = join(consumerRoot, "node_modules/eve/dist/src/cli/dev/tui/test/index.js");
    const { EveTUIRunner, MockScreen, MockUserInput, createPromptCommandHandler } = (await import(
      pathToFileURL(harnessPath).href
    )) as PackedTuiHarness;
    console.log(theme.muted("[tui-packed-install] installed TUI harness imported"));

    const screen = new MockScreen({ columns: 100, rows: 40 });
    const input = new MockUserInput();
    const runner = new EveTUIRunner({
      // `/model` never dispatches a turn; a turn in this test is a bug.
      session: {
        send: async () => {
          throw new Error("unexpected turn dispatched during /model smoke test");
        },
      },
      screen,
      userInput: input,
      name: "Packed install model command",
      appRoot: consumerRoot,
      initialInput: "/model",
      getVercelAuthStatus: async () => "authenticated",
      promptCommandHandler: createPromptCommandHandler({
        target: {
          kind: "local",
          serverUrl: "http://127.0.0.1:0",
          workspaceRoot: consumerRoot,
        },
      }),
      bootDetections: [
        {
          id: "test-model-setup-attention",
          detect: () => [
            {
              kind: "attention",
              label: "model provider not linked",
              command: "/model",
            },
          ],
        },
      ],
    });
    const runPromise = runner.run();

    try {
      // The provider picker paints before the first prompt only when the
      // prefilled onboarding `/model` flow and its module graph load — the
      // exact surface the oxc-parser regression crashed.
      await screen.waitForText("Configure the agent model", 15_000);
      await screen.waitForText("Which model provider do you want to use?", 15_000);
      console.log(theme.muted("[tui-packed-install] /model opened provider setup"));

      input.send("\x1b");
      await screen.waitForText("Change model", 5_000);
      input.send("\x1b");
      await screen.waitForText("/model dismissed.", 5_000);
      await screen.waitForIdlePrompt(5_000);

      input.type("/exit");
      input.enter();
      await withTimeout(runPromise, 5_000, "/exit did not terminate the runner");
      console.log(theme.muted("[tui-packed-install] OK"));
    } catch (error) {
      console.error(`[tui-packed-install] screen at failure:\n${screen.snapshot()}`);
      input.ctrlC();
      // ctrl-C is a no-op while the `/model` menu is parked waiting for a
      // selection, so an unbounded `await runPromise` hangs here — the `throw`
      // never runs, the outer catch never sets `process.exitCode`, and the idle
      // event loop drains to a false exit-0. Bound the unwind so the failure
      // always lands.
      await withTimeout(runPromise, 2_000, "runner did not unwind after ctrl-C").catch(() => {});
      throw error;
    }
  } finally {
    await rm(consumerRoot, { recursive: true, force: true });
  }
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

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
