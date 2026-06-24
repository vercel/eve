import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MockScreen } from "#cli/dev/tui/test/mock-terminal.js";
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
import { initAgentReplPrompt } from "./agent-instructions.js";
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
  typescriptPackageVersion: "7.0.1-rc",
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
  selectInitHandoff: ReturnType<typeof vi.fn<InitCommandDependencies["selectInitHandoff"]>>;
  spawnCodingAgentRepl: ReturnType<typeof vi.fn<InitCommandDependencies["spawnCodingAgentRepl"]>>;
  spawnPackageManager: ReturnType<typeof vi.fn<InitCommandDependencies["spawnPackageManager"]>>;
  tryInitializeGit: ReturnType<typeof vi.fn<InitCommandDependencies["tryInitializeGit"]>>;
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
    runPackageManagerInstall: vi.fn(async () => true),
    selectInitHandoff: vi.fn(async () => "eve-dev"),
    spawnCodingAgentRepl: vi.fn(async () => true),
    spawnPackageManager: vi.fn(async () => true),
    tryInitializeGit: vi.fn(async () => gitResult),
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
  it("creates the base agent with the runtime default model and invoking eve dependency", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-base-"));
    const output = logger();
    const deps = dependencies();
    deps.now
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(467)
      .mockReturnValueOnce(467)
      .mockReturnValueOnce(13_667);

    await runInitCommand(output, parentDirectory, "my-agent", {}, deps);

    const projectPath = join(parentDirectory, "my-agent");
    expect(await readFile(join(projectPath, "agent/agent.ts"), "utf8")).toContain(
      DEFAULT_AGENT_MODEL_ID,
    );
    const manifest = await readFile(join(projectPath, "package.json"), "utf8");
    expect(manifest).toContain('"eve": "^0.6.0"');
    // `@vercel/connect`'s optional `ai` peer rejects prereleases, so npm/yarn
    // need `ai` forced to the pinned prerelease or the install fails (ERESOLVE).
    const packageJson = JSON.parse(manifest) as {
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
      resolutions: Record<string, string>;
    };
    expect(packageJson.overrides.ai).toBe(packageJson.dependencies.ai);
    expect(packageJson.resolutions.ai).toBe(packageJson.dependencies.ai);
    await expect(pathExists(join(projectPath, "app"))).resolves.toBe(false);
    await expect(pathExists(join(projectPath, ".vercel"))).resolves.toBe(false);
    await expect(pathExists(join(projectPath, "vercel.json"))).resolves.toBe(false);
    // No visible invoking manager: the scaffold stays pnpm-managed.
    await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(true);
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectPath,
      expect.objectContaining({ bypassMinimumReleaseAge: true }),
    );
    expect(deps.tryInitializeGit).toHaveBeenCalledWith(projectPath);
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("pnpm", projectPath, [
      "exec",
      "eve",
      "dev",
    ]);
    // Substring assertions keep the expectations color-agnostic; picocolors
    // decides at import time whether the strings carry escape codes. The boot
    // banner is the CLI program's pre-action hook, not the command's output.
    expect(output.messages).toHaveLength(4);
    expect(output.messages[0]).toContain("Preparing project...");
    expect(output.messages[1]).toContain("✓");
    expect(output.messages[1]).toContain("Created an eve agent in ");
    expect(output.messages[1]).toContain(projectPath);
    expect(output.messages[1]).toContain("in 467ms");
    expect(output.messages[2]).toContain("Installed dependencies");
    expect(output.messages[2]).toContain("in 13.2s");
    expect(output.messages[3]).toContain("$ eve dev");
  });

  it("opens the selected coding-agent REPL instead of starting eve dev", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-repl-handoff-"));
    const output = logger();
    const deps = dependencies();
    deps.selectInitHandoff.mockResolvedValue("codex");

    await runInitCommand(output, parentDirectory, "my-agent", {}, deps);

    const projectPath = join(parentDirectory, "my-agent");
    expect(deps.spawnCodingAgentRepl).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex",
        cwd: projectPath,
        prompt: expect.stringContaining("pnpm exec eve dev --no-ui"),
      }),
    );
    const prompt = deps.spawnCodingAgentRepl.mock.calls[0]?.[0].prompt;
    expect(prompt).toBe(
      initAgentReplPrompt({
        devCommand: "pnpm exec eve dev",
      }),
    );
    expect(prompt).toContain("What should the agent do?");
    expect(prompt).toContain("HMR development server");
    expect(prompt).not.toContain(projectPath);
    expect(prompt).not.toContain("{{");
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
    expect(output.messages.at(-1)).toContain("$ codex");
  });

  it("keeps a completed init successful when its optional handoff is cancelled", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-repl-cancelled-"));
    const output = logger();
    const deps = dependencies();
    deps.selectInitHandoff.mockRejectedValue(new WizardCancelledError());

    await expect(
      runInitCommand(output, parentDirectory, "my-agent", {}, deps),
    ).resolves.toBeUndefined();

    const projectPath = join(parentDirectory, "my-agent");
    await expect(pathExists(join(projectPath, "agent/agent.ts"))).resolves.toBe(true);
    expect(deps.spawnCodingAgentRepl).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
    expect(output.errors).toEqual([]);
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

    await runInitCommand(output, parentDirectory, "host-app", {}, deps);

    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies.eve).toBe("file:/tmp/eve-0.11.5.tgz");
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
        expect.objectContaining({ bypassMinimumReleaseAge: true }),
      );
      expect(deps.tryInitializeGit).toHaveBeenCalledWith(projectPath);
      expect(deps.spawnPackageManager).toHaveBeenCalledWith("pnpm", projectPath, [
        "exec",
        "eve",
        "dev",
      ]);
      expect(output.messages[1]).toContain("Created an eve agent in ");
      expect(output.messages[1]).toContain(projectPath);
    },
  );

  it.each([
    ["npm", ["exec", "--", "eve", "dev"]],
    ["yarn", ["eve", "dev"]],
    ["bun", ["x", "eve", "dev"]],
  ] as const)(
    "scaffolds a fresh project owned by the invoking manager %s without pnpm policy",
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
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("bun", projectPath, ["x", "eve", "dev"]);
  });

  it.each([
    ["npm", "package-lock.json", "bun", ["exec", "--", "eve", "dev"]],
    ["yarn", "yarn.lock", "npm", ["eve", "dev"]],
    ["bun", "bun.lock", "npm", ["x", "eve", "dev"]],
    ["pnpm", "pnpm-lock.yaml", "npm", ["exec", "eve", "dev"]],
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
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
    const output = logger();
    const deps = dependencies();
    deps.detectInvokingPackageManager.mockReturnValue("npm");

    await runInitCommand(output, appsDirectory, "my-agent", {}, deps);

    const projectPath = join(appsDirectory, "my-agent");
    await expect(pathExists(join(projectPath, "pnpm-workspace.yaml"))).resolves.toBe(false);
    await expect(readFile(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      "packages:\n  - apps/*\n\nallowBuilds:\n  sharp: false\n\nminimumReleaseAgeExclude:\n  - eve\n",
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
      "packages:\n  - apps/*\n  - agents/*\n\nallowBuilds:\n  sharp: false\n\nminimumReleaseAgeExclude:\n  - eve\n",
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
      "packages:\n  - apps/*\n  - agents/*\n\nallowBuilds:\n  sharp: false\n\nminimumReleaseAgeExclude:\n  - eve\n",
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
    ["yarn", "yarn.lock", "resolutions", ["eve", "dev"]],
    ["bun", "bun.lock", "overrides", ["x", "eve", "dev"]],
  ] as const)(
    "scaffolds a fresh %s workspace member without nested root-only package fields",
    async (kind, lockfile, rootAiPinField, devArguments) => {
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
        overrides?: { ai?: string };
        resolutions?: { ai?: string };
      };
      expect(rootPackageJson.engines?.node).toBe("24.x");
      expect(rootPackageJson[rootAiPinField]?.ai).toBe("7.0.0");
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
    ]);
  });

  it("reports a Git initialization failure through the logger without failing", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-git-fail-"));
    const output = logger();
    const deps = dependencies({ kind: "failed", reason: "commit refused" });

    await runInitCommand(output, parentDirectory, "my-agent", {}, deps);

    expect(output.errors.join("\n")).toContain("Git initialization failed: commit refused");
    expect(deps.spawnPackageManager).toHaveBeenCalledWith(
      "pnpm",
      join(parentDirectory, "my-agent"),
      ["exec", "eve", "dev"],
    );
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
    // The compatibility extension stays limited to releases with the incomplete manifest.
    expect(await readFile(join(projectPath, "pnpm-workspace.yaml"), "utf8")).toContain(
      '"eve@>=0.6.0-beta.13 <=0.7.0":',
    );
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectPath,
      expect.anything(),
    );
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("pnpm", projectPath, [
      "exec",
      "eve",
      "dev",
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

  it.each(["../escape", "nested/agent", "My Agent"])(
    "rejects path-like or invalid agent name %j before scaffolding",
    async (name) => {
      const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-name-"));
      const output = logger();
      const deps = dependencies();

      await expect(runInitCommand(output, parentDirectory, name, {}, deps)).rejects.toThrow();

      expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
      expect(deps.tryInitializeGit).not.toHaveBeenCalled();
      expect(deps.spawnPackageManager).not.toHaveBeenCalled();
    },
  );

  it("adds an agent to an existing pnpm project directory", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-"));
    const projectRoot = await createHostProject(parentDirectory, {
      name: "host-app",
      dependencies: { zod: "^3.25.0" },
    });
    const output = logger();
    const deps = dependencies();

    await runInitCommand(output, parentDirectory, "host-app", {}, deps);

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
    expect(await readFile(join(projectRoot, "pnpm-workspace.yaml"), "utf8")).toContain(
      '"eve@>=0.6.0-beta.13 <=0.7.0":',
    );
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectRoot,
      expect.anything(),
    );
    // An existing project's history is its own; only fresh scaffolds get git init.
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("pnpm", projectRoot, [
      "exec",
      "eve",
      "dev",
    ]);
    expect(output.messages.join("\n")).toContain("Added an eve agent to ");
    expect(output.messages.join("\n")).not.toContain("Overrode package.json engines.node");
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

    await runInitCommand(output, parentDirectory, "host-app", {}, deps);

    expect(JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"))).toMatchObject({
      engines: { node: "24.x", npm: ">=10" },
    });
    expect(output.messages.join("\n")).toContain(
      '⚠ Overrode package.json engines.node from ">=24" to "24.x"',
    );
  });

  it("refuses a target directory without package.json before writing anything", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-no-pkg-"));
    const projectRoot = join(parentDirectory, "host-app");
    await mkdir(projectRoot, { recursive: true });
    const output = logger();
    const deps = dependencies();

    await expect(runInitCommand(output, parentDirectory, "host-app", {}, deps)).rejects.toThrow(
      "no package.json",
    );

    await expect(pathExists(join(projectRoot, "agent"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
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

      await runInitCommand(output, parentDirectory, "host-app", {}, deps);

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

    await runInitCommand(output, appsDirectory, "host-app", {}, deps);

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

    await runInitCommand(output, appsDirectory, "host-app", {}, deps);

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

    await expect(
      runInitCommand(output, parentDirectory, "host-app", {}, deps),
    ).rejects.toMatchObject({
      message: `Cannot add an eve agent to "${projectRoot}" because it already has: agent/instructions.md.`,
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
      runInitCommand(output, parentDirectory, "host-app", { channelWebNextjs: true }, deps),
    ).rejects.toThrow("eve channels add web");

    await expect(pathExists(join(projectRoot, "agent"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
  });

  it("hands a coding agent the setup guide when it omits the target", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-agent-bare-"));
    const output = logger();
    const deps = dependencies();
    deps.isCodingAgentLaunch.mockResolvedValue(true);

    await runInitCommand(output, parentDirectory, undefined, {}, deps);

    // A bare `eve init` from an agent means it has not chosen what to build, so
    // we print the guide and touch nothing — no scaffold, install, Git, or dev.
    await expect(pathExists(join(parentDirectory, "agent"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
    const printed = output.messages.join("\n");
    expect(printed).toContain("Set up an eve agent");
    expect(printed).toContain("npx eve@latest init <name>");
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
    expect(deps.selectInitHandoff).not.toHaveBeenCalled();
    expect(deps.spawnCodingAgentRepl).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
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

    await runInitCommand(output, parentDirectory, "host-app", {}, deps);

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
      return false;
    });

    await expect(runInitCommand(output, parentDirectory, "my-agent", {}, deps)).rejects.toThrow(
      "Failed to install dependencies",
    );

    await expect(pathExists(join(parentDirectory, "my-agent"))).resolves.toBe(true);
    expect(output.errors).toEqual(["Packages: +12", "ERR_PNPM_FETCH_404 not found"]);
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
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
      return false;
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
      return false;
    });

    await expect(runInitCommand(output, parentDirectory, "my-agent", {}, deps)).rejects.toThrow(
      "Failed to install dependencies",
    );

    expect(output.errors).toHaveLength(20);
    expect(output.errors.at(0)).toBe("npm silly step 5");
    expect(output.errors.at(-1)).toBe("npm silly step 24");
  });

  it("streams init phases and package-manager output as debug logs", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-debug-"));
    const output = logger();
    const deps = dependencies();
    deps.runPackageManagerInstall.mockImplementation(async (_kind, _projectPath, options) => {
      options?.onOutput?.({ stream: "stdout", text: "Progress: resolved 62, reused 62, done" });
      return true;
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
    deps.runPackageManagerInstall.mockResolvedValue(false);

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

  it("keeps interactive progress on one physical row", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-progress-"));
    const output = logger();
    const deps = dependencies();
    const screen = new MockScreen({ columns: 80, rows: 10 });
    const snapshots: string[] = [];
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");

    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: screen.columns });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      screen.write(chunk);
      snapshots.push(screen.snapshot());
      return true;
    });
    deps.isCodingAgentLaunch.mockResolvedValue(true);
    deps.detectInvokingPackageManager.mockReturnValue("npm");
    deps.runPackageManagerInstall.mockImplementation(async (_kind, _projectPath, options) => {
      options?.onOutput?.({ stream: "stderr", text: "npm silly config load:file:/tmp/.npmrc" });
      options?.onOutput?.({
        stream: "stderr",
        text: "npm silly fetch manifest @vercel/connect@0.2.2",
      });
      options?.onOutput?.({ stream: "stderr", text: "npm silly fetch manifest zod@4.4.3" });
      options?.onOutput?.({
        stream: "stderr",
        text: "npm http fetch GET https://registry.npmjs.org/@vercel%2fconnect attempt 1 failed with ENOTFOUND",
      });
      options?.onOutput?.({ stream: "stdout", text: `Downloading ${"package".repeat(20)}` });
      return true;
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
    expect(rendered).toContain("Preparing project");
    expect(rendered).toContain("Creating agent");
    expect(rendered).toContain("Installing dependencies");
    expect(rendered).toContain("npm install");
    expect(rendered).toContain("Resolving @vercel/connect@0.2.2");
    expect(rendered).toContain("npm registry · attempt 1 failed: ENOTFOUND");
    expect(rendered).not.toContain("config load:file");
    expect(rendered).toContain("Initializing Git repository");
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "npm",
      join(parentDirectory, "my-agent"),
      expect.objectContaining({ progressDetails: true }),
    );
    for (const snapshot of snapshots.filter(Boolean)) {
      expect(snapshot.split("\n")).toHaveLength(1);
      expect([...snapshot].length).toBeLessThan(screen.columns);
    }
  });
});
