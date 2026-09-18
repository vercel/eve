import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MockScreen, MockUserInput } from "#cli/dev/tui/test/mock-terminal.js";
import { TerminalRenderer } from "#cli/dev/tui/terminal-renderer.js";
import { EveTUIRunner } from "#cli/dev/tui/runner.js";
import { createDevBootProgressReporter } from "#cli/dev/boot-progress.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";
import * as liveRow from "#cli/ui/live-row.js";
import { Client, MessageResponse } from "#client/index.js";
import { createTestAgentInfoResult } from "#internal/testing/agent-info-fixture.js";
import { stampTestEvents } from "#internal/testing/events.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
import { packageInstallResult, packageProcessResult } from "#internal/testing/package-process.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import { detectPackageManager } from "#setup/package-manager.js";
import {
  addAgentToProject,
  type AddAgentToProjectOptions,
} from "#setup/scaffold/create/add-to-project.js";
import {
  ensureChannel,
  scaffoldBaseProject,
  type EnsureChannelOptions,
  type ScaffoldBaseProjectOptions,
} from "#setup/scaffold/index.js";
import { pathExists } from "#setup/path-exists.js";
import { WizardCancelledError } from "#setup/step.js";

import type { GitInitResult } from "./init-git.js";
import {
  EVE_INIT_PACKAGE_SPEC_ENV,
  runInitCommand,
  type InitCliLogger,
  type InitCommandDependencies,
} from "./init.js";

const BASE_VERSIONS = {
  aiPackageVersion: "7.0.0",
  connectPackageVersion: "0.2.2",
  evePackage: { version: "0.6.0", nodeEngine: ">=24" },
  typescriptPackageVersion: "7.0.2",
  zodPackageVersion: "4.0.0",
} as const;

const WEB_VERSIONS = {
  ...BASE_VERSIONS,
  nextPackageVersion: "16.0.0",
  reactDomPackageVersion: "19.0.0",
  reactPackageVersion: "19.0.0",
  streamdownPackageVersion: "2.0.0",
  typesReactDomPackageVersion: "19.0.0",
  typesReactPackageVersion: "19.0.0",
} as const;

function logger(): InitCliLogger & { messages: string[]; errors: string[] } {
  const messages: string[] = [];
  const errors: string[] = [];
  return {
    messages,
    errors,
    log: (message) => messages.push(message),
    error: (message) => errors.push(message),
  };
}

function dependencies(
  gitResult: GitInitResult = { kind: "initialized" },
): InitCommandDependencies & {
  detectInvokingPackageManager: ReturnType<
    typeof vi.fn<InitCommandDependencies["detectInvokingPackageManager"]>
  >;
  isCodingAgentLaunch: ReturnType<typeof vi.fn<InitCommandDependencies["isCodingAgentLaunch"]>>;
  now: ReturnType<typeof vi.fn<InitCommandDependencies["now"]>>;
  runPackageManagerInstall: ReturnType<
    typeof vi.fn<InitCommandDependencies["runPackageManagerInstall"]>
  >;
  spawnPackageManager: ReturnType<typeof vi.fn<InitCommandDependencies["spawnPackageManager"]>>;
  tryInitializeGit: ReturnType<typeof vi.fn<InitCommandDependencies["tryInitializeGit"]>>;
  validateModelSlug: ReturnType<typeof vi.fn<InitCommandDependencies["validateModelSlug"]>>;
} {
  return {
    addAgentToProject: (options: AddAgentToProjectOptions) => {
      const merged = { ...BASE_VERSIONS, ...options };
      if (options.evePackage === undefined) {
        merged.evePackage = BASE_VERSIONS.evePackage;
      }
      return addAgentToProject(merged);
    },
    // Stubbed to "no visible manager" so assertions do not depend on which
    // manager launched the test runner itself.
    detectInvokingPackageManager: vi.fn(() => undefined),
    // Stubbed to "human launch" for the same reason: the runner is often
    // launched by a coding agent, and these tests assert the human path.
    isCodingAgentLaunch: vi.fn(async () => false),
    now: vi.fn(() => 0),
    detectPackageManager,
    scaffoldBaseProject: (options: ScaffoldBaseProjectOptions) => {
      const merged = { ...BASE_VERSIONS, ...options };
      if (options.evePackage === undefined) {
        merged.evePackage = BASE_VERSIONS.evePackage;
      }
      return scaffoldBaseProject(merged);
    },
    ensureChannel: (options: EnsureChannelOptions) =>
      ensureChannel({
        ...options,
        webPackageVersions: { ...WEB_VERSIONS, ...options.webPackageVersions },
      }),
    runPackageManagerInstall: vi.fn(async () => packageInstallResult()),
    hasInteractiveTerminal: () => true,
    spawnPackageManager: vi.fn(async () => packageProcessResult()),
    tryInitializeGit: vi.fn(async () => gitResult),
    validateModelSlug: vi.fn(async () => null),
  };
}

/** A host project the dir-mode tests target: package.json plus a pnpm lockfile. */
async function createHostProject(
  parentDirectory: string,
  packageJson: Record<string, unknown> = { name: "host-app" },
): Promise<string> {
  const projectRoot = join(parentDirectory, "host-app");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(projectRoot, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n", "utf8");
  return projectRoot;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runInitCommand", () => {
  it.each(["install-failure", "cancelled", "startup-failure"] as const)(
    "clears progress before ending init on %s",
    async (outcome) => {
      vi.stubEnv("CI", "");
      vi.stubEnv("TERM", "xterm-256color");
      const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-interrupted-"));
      const screen = new MockScreen({ columns: 80, rows: 10 });
      const startRow = startCliLiveRow;
      vi.spyOn(liveRow, "startCliLiveRow").mockImplementation((log, options) =>
        startRow(log, { ...options, output: screen }),
      );
      const output = logger();
      const deps = dependencies();
      deps.runPackageManagerInstall.mockImplementation(async (_kind, _path, options) => {
        expect(screen.snapshot()).toContain("Installing dependencies");
        if (outcome === "cancelled") throw new WizardCancelledError();
        if (outcome === "install-failure") {
          options?.onOutput?.({ stream: "stderr", text: "npm error registry unavailable" });
          return packageInstallResult(1);
        }
        return packageInstallResult();
      });
      deps.spawnPackageManager.mockImplementation(async () => {
        expect(screen.snapshot()).toBe("");
        return packageProcessResult(1);
      });
      const run = runInitCommand(output, parentDirectory, "agent", {}, deps);
      if (outcome === "cancelled") await expect(run).resolves.toBeUndefined();
      else
        await expect(run).rejects.toThrow(
          outcome === "install-failure"
            ? "Failed to install dependencies"
            : "Development server exited unsuccessfully",
        );
      expect(screen.snapshot()).toBe("");
      if (outcome === "install-failure")
        expect(output.errors).toContain("npm error registry unavailable");
      if (outcome !== "startup-failure") expect(deps.spawnPackageManager).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "hands init through model connection to first chat (connected=%s)",
    async (connected) => {
      const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-chat-"));
      const output = logger();
      const deps = dependencies();
      const screen = new MockScreen({ columns: 100, rows: 30 });
      const input = new MockUserInput();
      const renderer = new TerminalRenderer({
        input,
        output: screen,
        captureForeignOutput: false,
        unicode: true,
      });
      const client = new Client({ host: "http://eve-test.invalid" });
      const baseInfo = createTestAgentInfoResult();
      const info = {
        ...baseInfo,
        agent: {
          ...baseInfo.agent,
          model: {
            id: "openai/test-model",
            routing: { kind: "gateway" as const, target: "openai" },
            endpoint: connected
              ? {
                  kind: "gateway" as const,
                  connected: true as const,
                  credential: "api-key" as const,
                }
              : { kind: "gateway" as const, connected: false as const },
          },
        },
      };
      vi.spyOn(client, "info").mockResolvedValue(info);
      const session = client.sessions.attach("session_init");
      vi.spyOn(session, "stream").mockImplementation(async function* () {});
      const send = vi.spyOn(session, "send").mockImplementation(
        async () =>
          new MessageResponse({
            sessionId: "session_init",
            cancelTurn: async () => ({ status: "no_active_turn" }),
            createStream: async function* () {
              yield* stampTestEvents([
                { type: "turn.started", data: { sequence: 1, turnId: "turn_init" } },
                {
                  type: "message.completed",
                  data: {
                    sequence: 2,
                    turnId: "turn_init",
                    stepIndex: 0,
                    finishReason: "stop",
                    message: "Hello Alice, your agent is ready.",
                  },
                },
                {
                  type: "session.waiting",
                  data: { continuationToken: "session_init", wait: "next-user-message" },
                },
              ]);
            },
          }),
      );
      const handle = vi.fn(async () => {
        if (!connected) {
          const provider = await renderer.setupFlow.readSelect({
            kind: "single",
            message: "Connect a model",
            options: [{ label: "Test connection", value: "test" }],
          });
          expect(provider).toEqual(["test"]);
        }
        return { message: connected ? "Using existing connection." : "Model connected." };
      });
      const readPrompt = vi.spyOn(renderer, "readPrompt");
      deps.spawnPackageManager.mockImplementation(async (_manager, projectPath, args) => {
        expect(args).toContain("--onboard");
        const progress = startCliLiveRow(output, { output: screen, elapsed: true });
        const report = createDevBootProgressReporter(progress);
        report({ type: "phase-started", phase: "compiling internal artifacts" });
        const runner = new EveTUIRunner({
          client,
          session,
          renderer,
          appRoot: projectPath,
          onboard: true,
          bootDetections: [],
          onBootProgress: report,
          detectProjectIdentity: async () => undefined,
          getVercelAuthStatus: async () => "authenticated",
          promptCommandHandler: { handle },
        });
        await runner.run();
        return packageProcessResult();
      });

      const run = runInitCommand(output, parentDirectory, "agent", {}, deps);
      void run.catch(() => {});
      try {
        if (!connected) {
          await screen.waitForText("Connect a model");
          expect(screen.snapshot()).not.toContain("Starting your agent");
          input.enter();
        }
        await vi.waitFor(() => expect(readPrompt).toHaveBeenCalled());
        expect(screen.snapshot()).not.toContain("/login");
        expect(screen.rawOutput()).not.toContain("Using existing connection.");
        expect(screen.rawOutput()).not.toContain("Model connected.");
        input.type("Hello, I'm Alice.");
        input.enter();
        await screen.waitForText("Hello Alice, your agent is ready.");
        await screen.waitForIdlePrompt();
        input.type("/exit");
        input.enter();
        await run;
        expect(send).toHaveBeenCalledOnce();
        expect(handle).toHaveBeenCalledOnce();
        expect(screen.snapshot()).not.toContain("Starting your agent");
        expect(screen.rawOutput()).not.toContain("compiling internal artifacts");
        expect(screen.rawOutput()).not.toContain("\u001B[3J");
        expect(output.messages.join("\n")).not.toContain("$ eve dev");
      } finally {
        renderer.requestInterrupt();
        await run.catch(() => {});
      }
    },
  );

  it.each([
    { interactive: true, agent: false },
    { interactive: false, agent: false },
    { interactive: true, agent: true },
  ])("keeps init inline with the shell command (%j)", async ({ interactive, agent }) => {
    vi.stubEnv("CI", "");
    vi.stubEnv("TERM", "xterm-256color");
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-inline-"));
    const screen = new MockScreen({ columns: 100, rows: 30 });
    const properties = ["isTTY", "rows", "columns"] as const;
    const original = properties.map((key) => Object.getOwnPropertyDescriptor(process.stdout, key));
    for (const key of properties) {
      Object.defineProperty(process.stdout, key, { configurable: true, value: screen[key] });
    }
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => screen.write(String(chunk)));
    const output = logger();
    output.log = (message) => {
      screen.write(`${message}\n`);
    };
    const deps = { ...dependencies(), hasInteractiveTerminal: () => interactive };
    deps.isCodingAgentLaunch.mockResolvedValue(agent);
    const shellOutput = "$ pnpm dlx eve init agent\nProgress: resolved 47, added 33, done\n";
    screen.write(shellOutput);
    try {
      await runInitCommand(output, parentDirectory, "agent", {}, deps);
      const transcript = stripAnsi(screen.snapshot());
      expect(transcript.startsWith(`${shellOutput}${interactive && !agent ? "\n" : ""}☰eve`)).toBe(
        true,
      );
      expect(transcript).not.toContain("\n\n\n");
      expect(screen.rawOutput()).not.toContain("\u001B[H");
      expect(screen.rawOutput()).not.toContain("\u001B[2J");
      expect(screen.rawOutput()).not.toContain("\u001B[3J");
      expect(transcript.match(/☰eve/gu)).toHaveLength(1);
      expect(deps.spawnPackageManager).toHaveBeenCalledTimes(interactive && !agent ? 1 : 0);
    } finally {
      for (const [index, key] of properties.entries()) {
        const descriptor = original[index];
        if (descriptor === undefined) Reflect.deleteProperty(process.stdout, key);
        else Object.defineProperty(process.stdout, key, descriptor);
      }
    }
  });

  it("returns after scaffolding without opening the TUI in a noninteractive terminal", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-headless-"));
    const deps = { ...dependencies(), hasInteractiveTerminal: () => false };
    await runInitCommand(logger(), parentDirectory, "agent", {}, deps);
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
    expect(deps.runPackageManagerInstall).toHaveBeenCalled();
  });

  it("creates an agent workspace from comma-separated names", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-agents-"));
    const output = logger();
    const deps = dependencies();

    await runInitCommand(
      output,
      parentDirectory,
      "operations",
      {
        agents: ["foreman", "researcher"],
      },
      deps,
    );

    const projectRoot = join(parentDirectory, "operations");
    await expect(
      pathExists(join(projectRoot, "agents", "foreman", "agent", "agent.ts")),
    ).resolves.toBe(true);
    await expect(
      pathExists(join(projectRoot, "agents", "researcher", "agent", "agent.ts")),
    ).resolves.toBe(true);
    await expect(pathExists(join(projectRoot, "agent"))).resolves.toBe(false);
    await expect(readFile(join(projectRoot, "tsconfig.json"), "utf8")).resolves.toContain(
      '"agents/**/*.ts"',
    );
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("pnpm", projectRoot, [
      "--reporter=silent",
      "exec",
      "eve",
      "dev",
      "--onboard",
    ]);
  });

  it("adds only agent files to an existing workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-init-workspace-agent-"));
    await mkdir(join(workspaceRoot, "agents", "support", "agent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      '{"name":"workspace","dependencies":{"eve":"*"}}\n',
    );
    const beforePackageJson = await readFile(join(workspaceRoot, "package.json"), "utf8");
    const output = logger();
    const deps = dependencies();

    await runInitCommand(output, workspaceRoot, "billing", {}, deps);

    await expect(
      pathExists(join(workspaceRoot, "agents", "billing", "agent", "agent.ts")),
    ).resolves.toBe(true);
    await expect(readFile(join(workspaceRoot, "package.json"), "utf8")).resolves.toBe(
      beforePackageJson,
    );
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
  });

  it("reports a target conflict when a workspace agent already exists", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-init-workspace-conflict-"));
    await mkdir(join(workspaceRoot, "agents", "support", "agent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      '{"name":"workspace","dependencies":{"eve":"*"}}\n',
    );
    const output = logger();
    const deps = dependencies();
    const terminalEvents: Array<{ failureCode?: string; result: string; step: string }> = [];

    await expect(
      runInitCommand(
        output,
        workspaceRoot,
        "support",
        {},
        deps,
        undefined,
        (step, result, failureCode) => {
          terminalEvents.push({ failureCode, result, step });
        },
      ),
    ).rejects.toThrow('Cannot create agent "support"');

    expect(terminalEvents).toEqual([
      { step: "resolve_target", result: "error", failureCode: "target_conflict" },
    ]);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
  });

  it("does not add a root agent when a path target is an eve workspace", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-workspace-path-parent-"));
    const workspaceRoot = join(parentDirectory, "workspace");
    await mkdir(join(workspaceRoot, "agents", "support", "agent"), { recursive: true });
    await writeFile(join(workspaceRoot, "agents", "support", "agent", "agent.ts"), "export {};\n");
    await writeFile(
      join(workspaceRoot, "package.json"),
      '{"name":"workspace","dependencies":{"eve":"*"}}\n',
    );
    const output = logger();
    const deps = dependencies();

    await expect(runInitCommand(output, parentDirectory, "workspace", {}, deps)).rejects.toThrow(
      "An eve project already exists",
    );

    await expect(pathExists(join(workspaceRoot, "agent"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
  });

  it("creates the base agent with the runtime default model and invoking eve dependency", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-base-"));
    const output = logger();
    const deps = dependencies();
    deps.now
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(467)
      .mockReturnValueOnce(467)
      .mockReturnValueOnce(13_667)
      .mockReturnValueOnce(13_800);

    await runInitCommand(output, parentDirectory, "my-agent", {}, deps);

    const projectPath = join(parentDirectory, "my-agent");
    expect(await readFile(join(projectPath, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    const manifest = await readFile(join(projectPath, "package.json"), "utf8");
    expect(manifest).toContain('"eve": "^0.6.0"');
    const packageJson: unknown = JSON.parse(manifest);
    expect(packageJson).not.toHaveProperty("overrides");
    expect(packageJson).not.toHaveProperty("resolutions");
    await expect(pathExists(join(projectPath, "app"))).resolves.toBe(false);
    await expect(pathExists(join(projectPath, ".vercel"))).resolves.toBe(false);
    await expect(pathExists(join(projectPath, "vercel.json"))).resolves.toBe(false);
    // No visible invoking manager: the scaffold stays pnpm-managed.
    await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(true);
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectPath,
      expect.any(Object),
    );
    expect(deps.tryInitializeGit).toHaveBeenCalledWith(projectPath);
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("pnpm", projectPath, [
      "--reporter=silent",
      "exec",
      "eve",
      "dev",
      "--onboard",
    ]);
    const messages = output.messages.map(stripAnsi);
    expect(messages).toHaveLength(7);
    expect(messages[0]).toBe("");
    expect(messages[1]).toContain("☰eve");
    expect(messages.slice(2, 5)).toEqual([
      "Creating agent...",
      "Installing dependencies...",
      "Initializing Git...",
    ]);
    expect(messages[5]).toBe(`✓ Created an eve agent in ${projectPath} in 13.8s`);
    expect(messages[6]).toBe("");
    expect(messages.join("\n")).not.toContain("$ eve dev");
    expect(output.messages.join("\n")).not.toContain("Instructions ");
  });

  it("creates a new agent with model settings selected by init options", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-model-"));
    const output = logger();
    const deps = dependencies();
    deps.isCodingAgentLaunch.mockResolvedValue(true);

    await runInitCommand(
      output,
      parentDirectory,
      "my-agent",
      { model: "openai/gpt-5.5", reasoning: "high" },
      deps,
    );

    const projectPath = join(parentDirectory, "my-agent");
    const agentSource = await readFile(join(projectPath, "agent/agent.ts"), "utf8");
    expect(agentSource).toContain('model: "openai/gpt-5.5"');
    const messages = stripAnsi(output.messages.join("\n"));
    expect(messages).toContain("✓ Model openai/gpt-5.5");
    expect(messages).not.toContain("openai/gpt-5.5 (eve default)");
    expect(messages).toContain(`✓ Instructions ${join(projectPath, "agent/instructions.md")}`);
    expect(agentSource).toContain('reasoning: "high"');
    expect(deps.validateModelSlug).toHaveBeenCalledWith(
      expect.stringContaining(".eve-init-"),
      "openai/gpt-5.5",
    );
  });

  it("omits authored reasoning when init uses the provider default", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-reasoning-default-"));
    const output = logger();
    const deps = dependencies();

    await runInitCommand(
      output,
      parentDirectory,
      "my-agent",
      { reasoning: "provider-default" },
      deps,
    );

    const agentSource = await readFile(join(parentDirectory, "my-agent", "agent/agent.ts"), "utf8");
    expect(agentSource).not.toContain("reasoning:");
  });

  it("rejects an invalid --model before creating the project", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-model-invalid-"));
    const output = logger();
    const deps = dependencies();
    deps.validateModelSlug.mockResolvedValue("Unknown model.");

    await expect(
      runInitCommand(output, parentDirectory, "my-agent", { model: "unknown/model" }, deps),
    ).rejects.toThrow("Unknown model.");

    await expect(pathExists(join(parentDirectory, "my-agent"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
  });

  it("does not offer self-modification when init was launched by a coding agent", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-agent-launched-selfmod-"));
    const output = logger();
    const deps = dependencies();
    deps.isCodingAgentLaunch.mockResolvedValue(true);

    await runInitCommand(output, parentDirectory, "my-agent", {}, deps);
  });

  it("uses an explicit init package spec for fresh project scaffolds", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-package-spec-"));
    const output = logger();
    const deps = dependencies();
    vi.stubEnv(EVE_INIT_PACKAGE_SPEC_ENV, "file:/tmp/eve-0.11.5.tgz");

    await runInitCommand(output, parentDirectory, "my-agent", {}, deps);

    const packageJson = JSON.parse(
      await readFile(join(parentDirectory, "my-agent", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies.eve).toBe("file:/tmp/eve-0.11.5.tgz");
  });

  it("uses an explicit init package spec when adding to an existing project", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-existing-package-spec-"));
    const projectRoot = await createHostProject(parentDirectory);
    const output = logger();
    const deps = dependencies();
    vi.stubEnv(EVE_INIT_PACKAGE_SPEC_ENV, "file:/tmp/eve-0.11.5.tgz");

    await runInitCommand(output, projectRoot, ".", {}, deps);

    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies.eve).toBe("file:/tmp/eve-0.11.5.tgz");
  });

  it.each([undefined, "."] as const)(
    "adds eve to the current existing project when target is %j",
    async (target) => {
      const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-existing-current-"));
      const projectRoot = await createHostProject(parentDirectory);
      const output = logger();
      const deps = dependencies();

      await runInitCommand(output, projectRoot, target, {}, deps);

      await expect(pathExists(join(projectRoot, "agent", "agent.ts"))).resolves.toBe(true);
      expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
        "pnpm",
        projectRoot,
        expect.anything(),
      );
    },
  );

  it("adds eve to an existing project addressed by a relative path", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-existing-path-"));
    const projectRoot = await createHostProject(parentDirectory);
    const output = logger();
    const deps = dependencies();

    await runInitCommand(output, parentDirectory, "host-app", {}, deps);

    await expect(pathExists(join(projectRoot, "agent", "agent.ts"))).resolves.toBe(true);
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectRoot,
      expect.anything(),
    );
  });

  it.each([undefined, ".", "./"] as const)(
    "scaffolds the current empty directory when target is %j",
    async (target) => {
      const projectPath = await mkdtemp(join(tmpdir(), "eve-init-current-"));
      const output = logger();
      const deps = dependencies();

      await runInitCommand(output, projectPath, target, {}, deps);

      expect(await readFile(join(projectPath, "agent/agent.ts"), "utf8")).toContain(
        DEFAULT_AGENT_MODEL_ID,
      );
      expect(JSON.parse(await readFile(join(projectPath, "package.json"), "utf8"))).toMatchObject({
        name: expect.stringMatching(/^eve-init-current-/),
      });
      await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(true);
      expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
        "pnpm",
        projectPath,
        expect.any(Object),
      );
      expect(deps.tryInitializeGit).toHaveBeenCalledWith(projectPath);
      expect(deps.spawnPackageManager).toHaveBeenCalledWith("pnpm", projectPath, [
        "--reporter=silent",
        "exec",
        "eve",
        "dev",
        "--onboard",
      ]);
      expect(output.messages.map(stripAnsi).join("\n")).toContain(
        `Created an eve agent in ${projectPath}`,
      );
    },
  );

  it("reports a target conflict for arbitrary non-empty current directories", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "eve-init-nonempty-"));
    await writeFile(join(projectPath, "notes.md"), "keep me\n", "utf8");
    const output = logger();
    const deps = dependencies();
    const terminalEvents: Array<{ failureCode?: string; result: string; step: string }> = [];

    await expect(
      runInitCommand(output, projectPath, ".", {}, deps, undefined, (step, result, failureCode) => {
        terminalEvents.push({ failureCode, result, step });
      }),
    ).rejects.toThrow("Cannot initialize an agent in the non-empty directory");

    await expect(readFile(join(projectPath, "notes.md"), "utf8")).resolves.toBe("keep me\n");
    await expect(pathExists(join(projectPath, "package.json"))).resolves.toBe(false);
    await expect(pathExists(join(projectPath, "agent"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
    expect(terminalEvents).toEqual([
      { step: "resolve_target", result: "error", failureCode: "target_conflict" },
    ]);
  });

  it.each([
    ["npm", ["exec", "--", "eve", "dev", "--onboard"]],
    ["yarn", ["eve", "dev", "--onboard"]],
    ["bun", ["x", "eve", "dev", "--onboard"]],
  ] as const)(
    "scaffolds a fresh project owned by the invoking manager %s without package-manager pins",
    async (kind, devArguments) => {
      const parentDirectory = await mkdtemp(join(tmpdir(), `eve-init-agent-${kind}-`));
      const output = logger();
      const deps = dependencies();
      deps.detectInvokingPackageManager.mockReturnValue(kind);

      await runInitCommand(output, parentDirectory, "my-agent", {}, deps);

      const projectPath = join(parentDirectory, "my-agent");
      expect(await readFile(join(projectPath, "agent/agent.ts"), "utf8")).toContain(
        DEFAULT_AGENT_MODEL_ID,
      );
      // The workspace policy is pnpm configuration; a scaffold owned by
      // another manager must not receive it.
      await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(false);
      const packageJson: unknown = JSON.parse(
        await readFile(join(projectPath, "package.json"), "utf8"),
      );
      expect(packageJson).not.toHaveProperty("overrides");
      expect(packageJson).not.toHaveProperty("resolutions");
      expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
        kind,
        projectPath,
        expect.anything(),
      );
      expect(deps.spawnPackageManager).toHaveBeenCalledWith(kind, projectPath, [...devArguments]);
    },
  );

  it("scaffolds a fresh named project with the ancestor packageManager before npx", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-init-bun-workspace-"));
    const appsDirectory = join(workspaceRoot, "apps");
    await mkdir(appsDirectory, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ private: true, packageManager: "bun@1.2.0" }, null, 2)}\n`,
      "utf8",
    );
    const output = logger();
    const deps = dependencies();
    deps.detectInvokingPackageManager.mockReturnValue("npm");

    await runInitCommand(output, appsDirectory, "amelie", {}, deps);

    const projectPath = join(appsDirectory, "amelie");
    expect(await readFile(join(projectPath, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "bun",
      projectPath,
      expect.anything(),
    );
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("bun", projectPath, [
      "x",
      "eve",
      "dev",
      "--onboard",
    ]);
  });

  it.each([
    ["npm", "package-lock.json", "bun", ["exec", "--", "eve", "dev", "--onboard"]],
    ["yarn", "yarn.lock", "npm", ["eve", "dev", "--onboard"]],
    ["bun", "bun.lock", "npm", ["x", "eve", "dev", "--onboard"]],
    ["pnpm", "pnpm-lock.yaml", "npm", ["--reporter=silent", "exec", "eve", "dev", "--onboard"]],
  ] as const)(
    "scaffolds a fresh named project with the ancestor %s lockfile before the launcher",
    async (kind, lockfile, invokingManager, devArguments) => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), `eve-init-${kind}-workspace-`));
      const appsDirectory = join(workspaceRoot, "apps");
      await mkdir(appsDirectory, { recursive: true });
      await writeFile(
        join(workspaceRoot, "package.json"),
        `${JSON.stringify({ private: true }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(join(workspaceRoot, lockfile), "", "utf8");
      const output = logger();
      const deps = dependencies();
      deps.detectInvokingPackageManager.mockReturnValue(invokingManager);

      await runInitCommand(output, appsDirectory, "my-agent", {}, deps);

      const projectPath = join(appsDirectory, "my-agent");
      expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
        kind,
        projectPath,
        expect.anything(),
      );
      expect(deps.spawnPackageManager).toHaveBeenCalledWith(kind, projectPath, [...devArguments]);
      await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(
        kind === "pnpm",
      );
    },
  );

  it("scaffolds a fresh pnpm workspace member without nested workspace policy", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-init-pnpm-workspace-"));
    const appsDirectory = join(workspaceRoot, "apps");
    await mkdir(appsDirectory, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ private: true, engines: { node: "22.x" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "pnpm-workspace.yaml"),
      "minimumReleaseAgeStrict: false\npackages:\n  - apps/*\n",
      "utf8",
    );
    const output = logger();
    const deps = dependencies();
    deps.detectInvokingPackageManager.mockReturnValue("npm");

    await runInitCommand(output, appsDirectory, "my-agent", {}, deps);

    const projectPath = join(appsDirectory, "my-agent");
    await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(false);
    await expect(readFile(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      "minimumReleaseAgeStrict: false\npackages:\n  - apps/*\n\nallowBuilds:\n  sharp: false\n",
    );
    const projectPackageJson = JSON.parse(
      await readFile(join(projectPath, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      engines?: unknown;
      overrides?: unknown;
      resolutions?: unknown;
    };
    expect(projectPackageJson.dependencies.eve).toBe("^0.6.0");
    expect(projectPackageJson.engines).toBeUndefined();
    expect(projectPackageJson.overrides).toBeUndefined();
    expect(projectPackageJson.resolutions).toBeUndefined();
    expect(JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x" },
    });
    expect(output.messages.join("\n")).toContain(
      `⚠ Updated workspace root configuration at ${join(workspaceRoot, "pnpm-workspace.yaml")}`,
    );
    expect(output.messages.join("\n")).toContain(
      `⚠ Updated workspace root package.json at ${join(workspaceRoot, "package.json")} (Overrode package.json engines.node from "22.x" to "24.x"`,
    );
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectPath,
      expect.anything(),
    );
  });

  it("scaffolds under an unclaimed pnpm workspace directory by adding a package pattern", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-init-pnpm-unclaimed-workspace-"));
    const agentsDirectory = join(workspaceRoot, "agents");
    await mkdir(agentsDirectory, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ private: true, engines: { node: "22.x" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
    const output = logger();
    const deps = dependencies();
    deps.detectInvokingPackageManager.mockReturnValue("npm");

    await runInitCommand(output, agentsDirectory, "my-agent", {}, deps);

    const projectPath = join(agentsDirectory, "my-agent");
    await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(false);
    await expect(readFile(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      "packages:\n  - apps/*\n  - agents/*\n\nallowBuilds:\n  sharp: false\n",
    );
    const projectPackageJson = JSON.parse(
      await readFile(join(projectPath, "package.json"), "utf8"),
    ) as {
      engines?: unknown;
      overrides?: unknown;
      resolutions?: unknown;
    };
    expect(projectPackageJson.engines).toBeUndefined();
    expect(projectPackageJson.overrides).toBeUndefined();
    expect(projectPackageJson.resolutions).toBeUndefined();
    expect(JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x" },
    });
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectPath,
      expect.anything(),
    );
  });

  it("adds Web Chat under an unclaimed pnpm workspace directory without nested workspace policy", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-init-web-pnpm-workspace-"));
    const agentsDirectory = join(workspaceRoot, "agents");
    await mkdir(agentsDirectory, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ private: true, engines: { node: "22.x" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
    const output = logger();
    const deps = dependencies();
    deps.detectInvokingPackageManager.mockReturnValue("npm");

    await runInitCommand(output, agentsDirectory, "web-agent", { channelWebNextjs: true }, deps);

    const projectPath = join(agentsDirectory, "web-agent");
    await expect(pathExists(join(projectPath, "app/page.tsx"))).resolves.toBe(true);
    await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(false);
    await expect(readFile(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      "packages:\n  - apps/*\n  - agents/*\n\nallowBuilds:\n  sharp: false\n",
    );
    const projectPackageJson = JSON.parse(
      await readFile(join(projectPath, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      engines?: unknown;
      overrides?: unknown;
      resolutions?: unknown;
    };
    expect(projectPackageJson.dependencies.eve).toBe("^0.6.0");
    expect(projectPackageJson.dependencies.next).toBe("16.0.0");
    expect(projectPackageJson.engines).toBeUndefined();
    expect(projectPackageJson.overrides).toBeUndefined();
    expect(projectPackageJson.resolutions).toBeUndefined();
    expect(JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x" },
    });
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectPath,
      expect.anything(),
    );
  });

  it.each([
    ["yarn", "yarn.lock", ["eve", "dev", "--onboard"]],
    ["bun", "bun.lock", ["x", "eve", "dev", "--onboard"]],
  ] as const)(
    "scaffolds a fresh %s workspace member without nested root-only package fields",
    async (kind, lockfile, devArguments) => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), `eve-init-${kind}-workspace-member-`));
      const appsDirectory = join(workspaceRoot, "apps");
      await mkdir(appsDirectory, { recursive: true });
      await writeFile(
        join(workspaceRoot, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            engines: { node: "22.x" },
            workspaces: ["apps/*"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(join(workspaceRoot, lockfile), "", "utf8");
      const output = logger();
      const deps = dependencies();
      deps.detectInvokingPackageManager.mockReturnValue("npm");

      await runInitCommand(output, appsDirectory, "my-agent", {}, deps);

      const projectPath = join(appsDirectory, "my-agent");
      const projectPackageJson = JSON.parse(
        await readFile(join(projectPath, "package.json"), "utf8"),
      ) as {
        engines?: unknown;
        overrides?: unknown;
        resolutions?: unknown;
      };
      expect(projectPackageJson.engines).toBeUndefined();
      expect(projectPackageJson.overrides).toBeUndefined();
      expect(projectPackageJson.resolutions).toBeUndefined();
      const rootPackageJson = JSON.parse(
        await readFile(join(workspaceRoot, "package.json"), "utf8"),
      ) as {
        engines?: { node?: string };
        overrides?: unknown;
        resolutions?: unknown;
      };
      expect(rootPackageJson.engines?.node).toBe("24.x");
      expect(rootPackageJson.overrides).toBeUndefined();
      expect(rootPackageJson.resolutions).toBeUndefined();
      expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
        kind,
        projectPath,
        expect.anything(),
      );
      expect(deps.spawnPackageManager).toHaveBeenCalledWith(kind, projectPath, [...devArguments]);
    },
  );

  it("adds Web Chat to an npm-owned fresh scaffold without pnpm configuration", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-agent-web-npm-"));
    const output = logger();
    const deps = dependencies();
    deps.detectInvokingPackageManager.mockReturnValue("npm");

    await runInitCommand(output, parentDirectory, "web-agent", { channelWebNextjs: true }, deps);

    const projectPath = join(parentDirectory, "web-agent");
    await expect(pathExists(join(projectPath, "app/page.tsx"))).resolves.toBe(true);
    await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "npm",
      projectPath,
      expect.anything(),
    );
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("npm", projectPath, [
      "exec",
      "--",
      "eve",
      "dev",
      "--onboard",
    ]);
  });

  it("reports a recoverable Git commit failure without failing init", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-git-fail-"));
    const output = logger();
    const deps = dependencies({
      kind: "failed",
      reason: "commit refused",
      repositoryInitialized: true,
      stage: "commit",
    });

    await runInitCommand(output, parentDirectory, "my-agent", {}, deps);

    const projectPath = join(parentDirectory, "my-agent");
    expect(stripAnsi(output.errors.join("\n"))).toContain(
      `Git initialization failed during commit: commit refused\nThe eve agent was created successfully. Git repository metadata and staged files were preserved at "${projectPath}"; the initial commit is optional.\n\nTo create it later, configure Git identity and run:\n  git -C ${JSON.stringify(projectPath)} commit -m "Initial commit from eve"`,
    );
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("pnpm", projectPath, [
      "--reporter=silent",
      "exec",
      "eve",
      "dev",
      "--onboard",
    ]);
  });

  it("adds Web Chat without Vercel configuration and preserves the invoking eve dependency", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-web-"));
    const output = logger();
    const deps = dependencies();

    await runInitCommand(output, parentDirectory, "web-agent", { channelWebNextjs: true }, deps);

    const projectPath = join(parentDirectory, "web-agent");
    await expect(pathExists(join(projectPath, "app/page.tsx"))).resolves.toBe(true);
    await expect(pathExists(join(projectPath, "vercel.json"))).resolves.toBe(false);
    expect(await readFile(join(projectPath, "next.config.ts"), "utf8")).toContain(
      "export default withEve(nextConfig);",
    );
    expect(await readFile(join(projectPath, "package.json"), "utf8")).toContain('"eve": "^0.6.0"');
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectPath,
      expect.anything(),
    );
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("pnpm", projectPath, [
      "--reporter=silent",
      "exec",
      "eve",
      "dev",
      "--onboard",
    ]);
  });

  it("removes the staged project when Web Chat scaffolding fails", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-web-fail-"));
    const output = logger();
    const deps = dependencies();
    deps.ensureChannel = vi.fn(async () => {
      throw new Error("web scaffold failed");
    });

    await expect(
      runInitCommand(output, parentDirectory, "web-agent", { channelWebNextjs: true }, deps),
    ).rejects.toThrow("web scaffold failed");

    await expect(pathExists(join(parentDirectory, "web-agent"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
  });

  it.each(["My Agent"])("rejects invalid target path %j before scaffolding", async (name) => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-name-"));
    const output = logger();
    const deps = dependencies();

    await expect(runInitCommand(output, parentDirectory, name, {}, deps)).rejects.toThrow();

    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
  });

  it("adds an agent to an existing pnpm project directory", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-"));
    const projectRoot = await createHostProject(parentDirectory, {
      name: "host-app",
      dependencies: { zod: "^3.25.0" },
    });
    const output = logger();
    const deps = dependencies();

    await runInitCommand(output, projectRoot, ".", {}, deps);

    expect(await readFile(join(projectRoot, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    await expect(pathExists(join(projectRoot, "agent/instructions.md"))).resolves.toBe(true);
    await expect(pathExists(join(projectRoot, "agent/channels/eve.ts"))).resolves.toBe(true);
    // Missing runtime deps are added; ones the project already declares stay.
    // A node engine is declared so Vercel builds on a supported Node rather
    // than a stale dashboard pin.
    expect(JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"))).toMatchObject({
      dependencies: { "@vercel/connect": "0.2.2", ai: "7.0.0", eve: "^0.6.0", zod: "^3.25.0" },
      engines: { node: "24.x" },
    });
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectRoot,
      expect.anything(),
    );
    // An existing project's history is its own; only fresh scaffolds get git init.
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("pnpm", projectRoot, [
      "--reporter=silent",
      "exec",
      "eve",
      "dev",
    ]);
    const printed = output.messages.join("\n");
    expect(printed).toContain("Added an eve agent to ");
    expect(printed).toContain("Updated existing project:");
    expect(printed).toContain("Created agent/agent.ts");
    expect(printed).toContain("Created agent/instructions.md");
    expect(printed).toContain("Added dependencies: @vercel/connect, ai, eve");
    expect(printed).toContain(`Updated ${join(projectRoot, "package.json")}`);
    expect(printed).toContain(`Updated ${join(projectRoot, "pnpm-workspace.yaml")}`);
    expect(printed).not.toContain("Overrode package.json engines.node");
  });

  it("adds an agent to an existing project with model settings selected by init options", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-model-"));
    const projectRoot = await createHostProject(parentDirectory);
    const output = logger();
    const deps = dependencies();

    await runInitCommand(
      output,
      projectRoot,
      ".",
      { model: "openai/gpt-5.5", reasoning: "high" },
      deps,
    );

    const agentSource = await readFile(join(projectRoot, "agent/agent.ts"), "utf8");
    expect(agentSource).toContain('model: "openai/gpt-5.5"');
    expect(agentSource).toContain('reasoning: "high"');
    expect(deps.validateModelSlug).toHaveBeenCalledWith(projectRoot, "openai/gpt-5.5");
  });

  it("overrides an incompatible existing node engine declaration and warns for eve init .", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-engine-"));
    const projectRoot = await createHostProject(parentDirectory, {
      name: "host-app",
      engines: { node: ">=22", npm: ">=10" },
    });
    const output = logger();
    const deps = dependencies();

    await runInitCommand(output, projectRoot, ".", {}, deps);

    expect(JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x", npm: ">=10" },
    });
    expect(output.messages.join("\n")).toContain(
      '⚠ Overrode package.json engines.node from ">=22" to "24.x"',
    );
  });

  it("replaces an open node engine range with the scaffolded major", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-engine-compatible-"));
    const projectRoot = await createHostProject(parentDirectory, {
      name: "host-app",
      engines: { node: ">=24", npm: ">=10" },
    });
    const output = logger();
    const deps = dependencies();

    await runInitCommand(output, projectRoot, ".", {}, deps);

    expect(JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x", npm: ">=10" },
    });
    expect(output.messages.join("\n")).toContain(
      '⚠ Overrode package.json engines.node from ">=24" to "24.x"',
    );
  });

  it("preserves a preexisting Git-only directory while scaffolding it", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-git-only-"));
    const projectRoot = join(parentDirectory, "host-app");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, ".git/HEAD"), "ref: refs/heads/main\n", "utf8");
    const output = logger();
    const deps = dependencies();

    await runInitCommand(output, projectRoot, ".", {}, deps);

    await expect(readdir(projectRoot)).resolves.toContain(".git");
    await expect(readFile(join(projectRoot, ".git/HEAD"), "utf8")).resolves.toBe(
      "ref: refs/heads/main\n",
    );
    await expect(pathExists(join(projectRoot, "agent"))).resolves.toBe(true);
    expect(deps.runPackageManagerInstall).toHaveBeenCalled();
  });

  it("uses a preexisting empty named directory for a fresh project", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-empty-"));
    const projectRoot = join(parentDirectory, "host-app");
    await mkdir(projectRoot, { recursive: true });
    const output = logger();
    const deps = dependencies();

    await runInitCommand(output, projectRoot, ".", {}, deps);

    await expect(pathExists(join(projectRoot, "agent/agent.ts"))).resolves.toBe(true);
    expect(deps.tryInitializeGit).toHaveBeenCalledWith(projectRoot);
  });

  it("restores a preexisting empty named directory when installation fails", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-empty-fail-"));
    const projectRoot = join(parentDirectory, "host-app");
    await mkdir(projectRoot, { recursive: true });
    const output = logger();
    const deps = dependencies();
    deps.runPackageManagerInstall.mockResolvedValue(packageInstallResult(1));

    await expect(runInitCommand(output, projectRoot, ".", {}, deps)).rejects.toThrow("restored");

    await expect(readdir(projectRoot)).resolves.toEqual([]);
  });

  it("refuses an invalid host package.json before writing agent files", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-invalid-pkg-"));
    const projectRoot = join(parentDirectory, "host-app");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "package.json"), '{ "name": }\n', "utf8");
    const output = logger();
    const deps = dependencies();

    await expect(runInitCommand(output, projectRoot, ".", {}, deps)).rejects.toThrow(
      "not valid JSON",
    );

    await expect(pathExists(join(projectRoot, "agent"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
  });

  it.each([
    ["npm", "package-lock.json", ["exec", "--", "eve", "dev"]],
    ["yarn", "yarn.lock", ["eve", "dev"]],
    ["bun", "bun.lock", ["x", "eve", "dev"]],
  ] as const)(
    "drives an existing %s project with its own manager and no pnpm policy",
    async (kind, lockfile, devArguments) => {
      const parentDirectory = await mkdtemp(join(tmpdir(), `eve-init-dir-${kind}-`));
      const projectRoot = join(parentDirectory, "host-app");
      await mkdir(projectRoot, { recursive: true });
      await writeFile(join(projectRoot, "package.json"), '{ "name": "host-app" }\n', "utf8");
      await writeFile(join(projectRoot, lockfile), "", "utf8");
      const output = logger();
      const deps = dependencies();

      await runInitCommand(output, projectRoot, ".", {}, deps);

      expect(await readFile(join(projectRoot, "agent/agent.ts"), "utf8")).toContain(
        DEFAULT_AGENT_MODEL_ID,
      );
      expect(JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"))).toMatchObject({
        dependencies: { eve: "^0.6.0" },
      });
      // The workspace policy is pnpm configuration; it must not leak into
      // projects owned by other managers.
      await expect(pathExists(join(projectRoot, "pnpm-workspace.yaml"))).resolves.toBe(false);
      expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
        kind,
        projectRoot,
        expect.anything(),
      );
      expect(deps.spawnPackageManager).toHaveBeenCalledWith(kind, projectRoot, [...devArguments]);
    },
  );

  it("adds an agent to an existing project with the ancestor package manager", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-init-existing-workspace-"));
    const appsDirectory = join(workspaceRoot, "apps");
    const projectRoot = join(appsDirectory, "host-app");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ private: true, packageManager: "bun@1.2.0" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(projectRoot, "package.json"), '{ "name": "host-app" }\n', "utf8");
    const output = logger();
    const deps = dependencies();
    deps.detectInvokingPackageManager.mockReturnValue("npm");

    await runInitCommand(output, projectRoot, ".", {}, deps);

    expect(await readFile(join(projectRoot, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    await expect(pathExists(join(projectRoot, "pnpm-workspace.yaml"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "bun",
      projectRoot,
      expect.anything(),
    );
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("bun", projectRoot, ["x", "eve", "dev"]);
  });

  it("adds an agent to an existing pnpm workspace member without nested root-only policy", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-init-existing-pnpm-workspace-"));
    const appsDirectory = join(workspaceRoot, "apps");
    const projectRoot = join(appsDirectory, "host-app");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      `${JSON.stringify({ private: true, engines: { node: "22.x" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
    await writeFile(join(projectRoot, "package.json"), '{ "name": "host-app" }\n', "utf8");
    const output = logger();
    const deps = dependencies();
    deps.detectInvokingPackageManager.mockReturnValue("npm");

    await runInitCommand(output, projectRoot, ".", {}, deps);

    expect(await readFile(join(projectRoot, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    await expect(pathExists(join(projectRoot, "pnpm-workspace.yaml"))).resolves.toBe(false);
    const projectPackageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string>; engines?: unknown };
    expect(projectPackageJson.dependencies.eve).toBe("^0.6.0");
    expect(projectPackageJson.engines).toBeUndefined();
    expect(JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x" },
    });
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectRoot,
      expect.anything(),
    );
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
  });

  it("reports agent file conflicts before writing anything", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-conflict-"));
    const projectRoot = await createHostProject(parentDirectory);
    await mkdir(join(projectRoot, "agent"), { recursive: true });
    await writeFile(join(projectRoot, "agent/instructions.md"), "existing\n", "utf8");
    const output = logger();
    const deps = dependencies();

    await expect(runInitCommand(output, projectRoot, ".", {}, deps)).rejects.toMatchObject({
      message: `An eve project already exists at "${projectRoot}". Run \`eve dev\` from that directory, or use an existing-project command.`,
    });

    await expect(pathExists(join(projectRoot, "agent/agent.ts"))).resolves.toBe(false);
    expect(await readFile(join(projectRoot, "agent/instructions.md"), "utf8")).toBe("existing\n");
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
  });

  it("refuses --channel-web-nextjs when targeting an existing project", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-web-"));
    const projectRoot = await createHostProject(parentDirectory);
    const output = logger();
    const deps = dependencies();

    await expect(
      runInitCommand(output, projectRoot, ".", { channelWebNextjs: true }, deps),
    ).rejects.toThrow("eve add channel/web");

    await expect(pathExists(join(projectRoot, "agent"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
  });

  it("scaffolds the current directory for a coding agent that omits the target", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-agent-bare-"));
    const output = logger();
    const deps = dependencies();
    deps.isCodingAgentLaunch.mockResolvedValue(true);

    await runInitCommand(output, parentDirectory, undefined, {}, deps);

    expect(await readFile(join(parentDirectory, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      parentDirectory,
      expect.anything(),
    );
    expect(deps.tryInitializeGit).toHaveBeenCalledWith(parentDirectory);
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
    expect(output.messages.join("\n")).toContain("Created an eve agent in");
  });

  it("scaffolds and initializes Git for a coding agent but does not spawn the dev server", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-agent-named-"));
    const output = logger();
    const deps = dependencies();
    deps.isCodingAgentLaunch.mockResolvedValue(true);

    await runInitCommand(output, parentDirectory, "my-agent", {}, deps);

    const projectPath = join(parentDirectory, "my-agent");
    expect(await readFile(join(projectPath, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectPath,
      expect.anything(),
    );
    expect(deps.tryInitializeGit).toHaveBeenCalledWith(projectPath);
    // The dev server is handed off as text, never spawned — the dev TUI would
    // wedge the launching agent. The handoff's content is the unit test's job.
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
    const messages = stripAnsi(output.messages.join("\n"));
    expect(messages).toContain(`✓ Model ${DEFAULT_AGENT_MODEL_ID} (eve default)`);
    expect(messages).toContain(`✓ Instructions ${join(projectPath, "agent/instructions.md")}`);
    expect(messages).toContain("pnpm --reporter=silent exec eve dev --no-ui");
  });

  it("derives the agent dev handoff command from the existing project's own manager", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-agent-dir-"));
    const projectRoot = join(parentDirectory, "host-app");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "package.json"), '{ "name": "host-app" }\n', "utf8");
    await writeFile(join(projectRoot, "package-lock.json"), "", "utf8");
    const output = logger();
    const deps = dependencies();
    deps.isCodingAgentLaunch.mockResolvedValue(true);

    await runInitCommand(output, projectRoot, ".", {}, deps);

    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
    expect(output.messages.join("\n")).toContain("npm exec -- eve dev");
  });

  it("stops before Git and dev when dependency installation fails, replaying its output", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-install-fail-"));
    const output = logger();
    const deps = dependencies();
    deps.runPackageManagerInstall.mockImplementation(async (_kind, _projectPath, options) => {
      options?.onOutput?.({ stream: "stdout", text: "Packages: +12" });
      options?.onOutput?.({ stream: "stderr", text: "ERR_PNPM_FETCH_404 not found" });
      return packageInstallResult(1);
    });

    await expect(runInitCommand(output, parentDirectory, "my-agent", {}, deps)).rejects.toThrow(
      "Failed to install dependencies",
    );

    await expect(pathExists(join(parentDirectory, "my-agent"))).resolves.toBe(false);
    expect(output.errors).toEqual(["Packages: +12", "ERR_PNPM_FETCH_404 not found"]);
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
  });

  it("hands off to pnpm dev without extra configuration", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dev-"));
    const output = logger();
    const deps = dependencies();

    await expect(
      runInitCommand(output, parentDirectory, "my-agent", {}, deps),
    ).resolves.toBeUndefined();
    expect(deps.spawnPackageManager).toHaveBeenCalledTimes(1);
    expect(deps.spawnPackageManager).toHaveBeenCalledWith(
      "pnpm",
      join(parentDirectory, "my-agent"),
      ["--reporter=silent", "exec", "eve", "dev", "--onboard"],
    );
  });

  it("categorizes a missing package manager without collecting process output", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-spawn-fail-"));
    const output = logger();
    const deps = dependencies();
    const terminalEvents: Array<{ failureCode?: string; result: string; step: string }> = [];
    deps.runPackageManagerInstall.mockResolvedValue({
      kind: "installed",
      result: {
        command: { executable: "pnpm", args: ["install"], cwd: parentDirectory },
        termination: { kind: "spawn-error", code: "ENOENT", message: "spawn pnpm ENOENT" },
        stdout: "",
      },
    });

    await expect(
      runInitCommand(
        output,
        parentDirectory,
        "my-agent",
        {},
        deps,
        undefined,
        (step, result, failureCode) => {
          terminalEvents.push({ failureCode, result, step });
        },
      ),
    ).rejects.toThrow("Failed to install dependencies");

    expect(output.errors).toEqual(["pnpm was not found. Install it before running this step."]);
    expect(terminalEvents).toEqual([
      {
        step: "install_dependencies",
        result: "error",
        failureCode: "package_manager_not_found",
      },
    ]);
  });

  it("preserves an existing host after install failure and prints the retry command", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-host-install-fail-"));
    const projectRoot = await createHostProject(parentDirectory);
    const output = logger();
    const deps = dependencies();
    deps.runPackageManagerInstall.mockResolvedValue(packageInstallResult(1));

    await expect(runInitCommand(output, projectRoot, ".", {}, deps)).rejects.toThrow(
      `install dependencies with pnpm in "${projectRoot}"`,
    );

    await expect(pathExists(join(projectRoot, "agent/agent.ts"))).resolves.toBe(true);
    expect(JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"))).toMatchObject({
      dependencies: { eve: "^0.6.0" },
    });
    expect(output.messages.join("\n")).toContain("Updated existing project:");
    expect(output.messages.join("\n")).toContain("Created agent/agent.ts");
    expect(output.messages.join("\n")).toContain(
      "Added dependencies: @vercel/connect, ai, eve, zod",
    );
  });

  it("replays only the actionable npm error, dropping silly/verbose/http/timing noise", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-npm-noise-"));
    const output = logger();
    const deps = dependencies();
    deps.runPackageManagerInstall.mockImplementation(async (_kind, _projectPath, options) => {
      options?.onOutput?.({ stream: "stderr", text: "npm silly logfile start cleaning logs" });
      options?.onOutput?.({ stream: "stderr", text: "npm verbose cli /usr/local/bin/node" });
      options?.onOutput?.({
        stream: "stderr",
        text: "npm http fetch GET 200 https://registry.npmjs.org/eve 41ms",
      });
      options?.onOutput?.({ stream: "stderr", text: "npm timing idealTree Completed in 42ms" });
      options?.onOutput?.({ stream: "stderr", text: "npm error code ERESOLVE" });
      options?.onOutput?.({
        stream: "stderr",
        text: "npm error ERESOLVE unable to resolve dependency tree",
      });
      return packageInstallResult(1);
    });

    await expect(runInitCommand(output, parentDirectory, "my-agent", {}, deps)).rejects.toThrow(
      "Failed to install dependencies",
    );

    expect(output.errors).toEqual([
      "npm error code ERESOLVE",
      "npm error ERESOLVE unable to resolve dependency tree",
    ]);
    expect(output.errors.join("\n")).not.toMatch(/npm (?:silly|verbose|http|timing)/u);
  });

  it("replays only the final npm detail lines when filtering leaves no error", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-npm-fallback-"));
    const output = logger();
    const deps = dependencies();
    deps.runPackageManagerInstall.mockImplementation(async (_kind, _projectPath, options) => {
      for (let index = 0; index < 25; index += 1) {
        options?.onOutput?.({ stream: "stderr", text: `npm silly step ${index}` });
      }
      options?.onOutput?.({ stream: "stderr", text: "" });
      return packageInstallResult(1);
    });

    await expect(runInitCommand(output, parentDirectory, "my-agent", {}, deps)).rejects.toThrow(
      "Failed to install dependencies",
    );

    expect(output.errors).toHaveLength(21);
    expect(output.errors.at(0)).toContain("Earlier install output omitted");
    expect(output.errors.at(1)).toBe("npm silly step 5");
    expect(output.errors.at(-1)).toBe("npm silly step 24");
  });

  it("streams init phases and package-manager output as debug logs", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-debug-"));
    const output = logger();
    const deps = dependencies();
    deps.runPackageManagerInstall.mockImplementation(async (_kind, _projectPath, options) => {
      options?.onOutput?.({ stream: "stdout", text: "Progress: resolved 62, reused 62, done" });
      return packageInstallResult();
    });

    const previous = process.env.EVE_LOG_LEVEL;
    process.env.EVE_LOG_LEVEL = "debug";
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runInitCommand(output, parentDirectory, "my-agent", {}, deps);
      const debugLines = consoleLog.mock.calls.map((call) => String(call[0]));
      expect(debugLines).toContain("[eve:init] creating agent");
      expect(
        debugLines.some((line) => line.startsWith("[eve:init] installing dependencies with")),
      ).toBe(true);
      expect(debugLines).toContain("[eve:init] Progress: resolved 62, reused 62, done");
      expect(debugLines).toContain("[eve:init] initializing git repository");
      expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ progressDetails: false }),
      );
    } finally {
      consoleLog.mockRestore();
      if (previous === undefined) {
        delete process.env.EVE_LOG_LEVEL;
      } else {
        process.env.EVE_LOG_LEVEL = previous;
      }
    }
  });

  it("reports a failed install as failed under debug", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-debug-failure-"));
    const output = logger();
    const deps = dependencies();
    deps.runPackageManagerInstall.mockResolvedValue(packageInstallResult(1));

    const previous = process.env.EVE_LOG_LEVEL;
    process.env.EVE_LOG_LEVEL = "debug";
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runInitCommand(output, parentDirectory, "my-agent", {}, deps)).rejects.toThrow(
        "Failed to install dependencies",
      );
      const debugLines = consoleLog.mock.calls.map((call) => String(call[0]));
      expect(debugLines.some((line) => line.includes("dependency installation failed"))).toBe(true);
      expect(debugLines.some((line) => line.includes("dependencies installed"))).toBe(false);
    } finally {
      consoleLog.mockRestore();
      if (previous === undefined) {
        delete process.env.EVE_LOG_LEVEL;
      } else {
        process.env.EVE_LOG_LEVEL = previous;
      }
    }
  });

  it.each(["npm", "pnpm", "yarn", "bun"] as const)(
    "keeps %s output behind one native progress row",
    async (manager) => {
      vi.stubEnv("CI", "");
      vi.stubEnv("TERM", "xterm-256color");
      const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-progress-"));
      const output = logger();
      const deps = dependencies();
      const screen = new MockScreen({ columns: 80, rows: 10 });
      const snapshots: string[] = [];
      const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");

      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: screen.columns,
      });
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        screen.write(chunk);
        snapshots.push(screen.snapshot());
        return true;
      });
      deps.detectInvokingPackageManager.mockReturnValue(manager);
      deps.runPackageManagerInstall.mockImplementation(async (_kind, _projectPath, options) => {
        options?.onOutput?.({ stream: "stderr", text: "npm silly config load:file:/tmp/.npmrc" });
        options?.onOutput?.({
          stream: "stderr",
          text: "npm silly fetch manifest @vercel/connect@0.2.2",
        });
        options?.onOutput?.({ stream: "stderr", text: "npm silly fetch manifest zod@4.5.4" });
        options?.onOutput?.({
          stream: "stderr",
          text: "npm http fetch GET https://registry.npmjs.org/@vercel%2fconnect attempt 1 failed with ENOTFOUND",
        });
        options?.onOutput?.({ stream: "stdout", text: `Downloading ${"package".repeat(20)}` });
        return packageInstallResult();
      });

      try {
        await runInitCommand(output, parentDirectory, "my-agent", {}, deps);
      } finally {
        if (isTtyDescriptor === undefined) {
          Reflect.deleteProperty(process.stdout, "isTTY");
        } else {
          Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
        }
        if (columnsDescriptor === undefined) {
          Reflect.deleteProperty(process.stdout, "columns");
        } else {
          Object.defineProperty(process.stdout, "columns", columnsDescriptor);
        }
      }

      const rendered = snapshots.join("\n");
      expect(rendered).toContain("Creating agent");
      expect(rendered).toContain("Installing dependencies");
      expect(rendered).toContain(`${manager} · 0s`);
      expect(rendered).not.toContain("Resolving");
      expect(rendered).not.toContain("ENOTFOUND");
      expect(rendered).not.toContain("Downloading");
      expect(rendered).not.toContain("config load:file");
      expect(rendered).toContain("Initializing Git");
      expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
        manager,
        join(parentDirectory, "my-agent"),
        expect.objectContaining({ progressDetails: false }),
      );
      for (const snapshot of snapshots.filter(Boolean)) {
        expect(snapshot.split("\n")).toHaveLength(1);
        expect([...snapshot].length).toBeLessThan(screen.columns);
      }
    },
  );
});
