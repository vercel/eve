import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { theme } from "./lib/theme.ts";

const root = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(root, "..", "..");

process.env.EVE_TUI_UNICODE = "1";

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
    process.env.HOME = consumerRoot;
    process.env.USERPROFILE = consumerRoot;
    process.env.XDG_DATA_HOME = join(consumerRoot, "data");
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AI_GATEWAY_API_KEY",
      "VERCEL_OIDC_TOKEN",
      "VERCEL_TOKEN",
    ])
      delete process.env[key];
    const tarballPath = join(consumerRoot, "eve.tgz");

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
    await exec(
      "npm",
      ["install", "--min-release-age=0", "--no-audit", "--no-fund", "--loglevel=error"],
      consumerRoot,
    );
    console.log(theme.muted("[tui-packed-install] consumer npm install completed"));

    const agentRoot = join(consumerRoot, "agent");
    await mkdir(agentRoot);
    await Promise.all([
      writeFile(
        join(agentRoot, "agent.ts"),
        'import { defineAgent } from "eve";\n\nexport default defineAgent({\n  model: "spacexai/grok-4.7",\n});\n',
      ),
      writeFile(join(agentRoot, "instructions.md"), "Help Alice with her questions.\n"),
    ]);

    const harnessPath = join(consumerRoot, "node_modules/eve/dist/src/cli/dev/tui/test/index.js");
    const { EveTUIRunner, MockScreen, MockUserInput, createPromptCommandHandler } = (await import(
      pathToFileURL(harnessPath).href
    )) as PackedTuiHarness;
    console.log(theme.muted("[tui-packed-install] installed TUI harness imported"));

    const screen = new MockScreen({ columns: 100, rows: 40 });
    const input = new MockUserInput();
    const runner = new EveTUIRunner({
      screen,
      userInput: input,
      name: "Packed install model command",
      appRoot: consumerRoot,
      onboard: true,
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
              command: "/login",
            },
          ],
        },
      ],
    });
    const runPromise = runner.run();

    try {
      await screen.waitForText("Vercel Account", 15_000);
      await screen.waitForText("Anthropic API Key", 5_000);
      console.log(theme.muted("[tui-packed-install] /login opened connection setup"));

      input.send("\x1b");
      await screen.waitForIdlePrompt(5_000);

      input.type("/exit");
      input.enter();
      await withTimeout(runPromise, 5_000, "/exit did not terminate the runner");
      console.log(theme.muted("[tui-packed-install] OK"));
    } catch (error) {
      console.error(`[tui-packed-install] screen at failure:\n${screen.snapshot()}`);
      input.ctrlC();
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
