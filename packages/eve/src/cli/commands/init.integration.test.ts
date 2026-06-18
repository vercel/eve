import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  tsgoPackageVersion: "7.0.0",
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
  runPackageManagerInstall: ReturnType<
    typeof vi.fn<InitCommandDependencies["runPackageManagerInstall"]>
  >;
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
    spawnPackageManager: vi.fn(async () => true),
    tryInitializeGit: vi.fn(() => gitResult),
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
      "--input",
      "/model",
    ]);
    // Substring assertions keep the expectations color-agnostic; picocolors
    // decides at import time whether the strings carry escape codes. The boot
    // banner is the CLI program's pre-action hook, not the command's output.
    expect(output.messages).toHaveLength(4);
    expect(output.messages[0]).toContain("✓");
    expect(output.messages[0]).toContain("Created an eve agent in ");
    expect(output.messages[0]).toContain(projectPath);
    expect(output.messages[1]).toContain("Installing dependencies...");
    expect(output.messages[2]).toContain("Installed dependencies");
    expect(output.messages[3]).toContain("$ eve dev --input /model");
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
        "--input",
        "/model",
      ]);
      expect(output.messages[0]).toContain("Created an eve agent in ");
      expect(output.messages[0]).toContain(projectPath);
    },
  );

  it.each([
    ["npm", ["exec", "--", "eve", "dev", "--input", "/model"]],
    ["yarn", ["eve", "dev", "--input", "/model"]],
    ["bun", ["x", "eve", "dev", "--input", "/model"]],
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
    expect(deps.spawnPackageManager).toHaveBeenCalledWith("bun", projectPath, [
      "x",
      "eve",
      "dev",
      "--input",
      "/model",
    ]);
  });

  it.each([
    ["npm", "package-lock.json", "bun", ["exec", "--", "eve", "dev", "--input", "/model"]],
    ["yarn", "yarn.lock", "npm", ["eve", "dev", "--input", "/model"]],
    ["bun", "bun.lock", "npm", ["x", "eve", "dev", "--input", "/model"]],
    ["pnpm", "pnpm-lock.yaml", "npm", ["exec", "eve", "dev", "--input", "/model"]],
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
      "--input",
      "/model",
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
      ["exec", "eve", "dev", "--input", "/model"],
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
      "--input",
      "/model",
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

  it("reports agent file conflicts before writing anything", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-dir-conflict-"));
    const projectRoot = await createHostProject(parentDirectory);
    await mkdir(join(projectRoot, "agent"), { recursive: true });
    await writeFile(join(projectRoot, "agent/instructions.md"), "existing\n", "utf8");
    const output = logger();
    const deps = dependencies();

    await expect(runInitCommand(output, parentDirectory, "host-app", {}, deps)).rejects.toThrow(
      "agent/instructions.md",
    );

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

  it("scaffolds the current directory for a coding agent that omits the target", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-init-agent-bare-"));
    const output = logger();
    const deps = dependencies();
    deps.isCodingAgentLaunch.mockResolvedValue(true);
    deps.detectInvokingPackageManager.mockReturnValue("pnpm");

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
    expect(output.messages.join("\n")).toContain("Do not start `eve dev`");
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
      options?.onOutput?.({ stream: "stderr", text: "ERR_PNPM_FETCH_404 not found" });
      return false;
    });

    await expect(runInitCommand(output, parentDirectory, "my-agent", {}, deps)).rejects.toThrow(
      "Failed to install dependencies",
    );

    await expect(pathExists(join(parentDirectory, "my-agent"))).resolves.toBe(true);
    expect(output.errors.join("\n")).toContain("ERR_PNPM_FETCH_404 not found");
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
    expect(deps.spawnPackageManager).not.toHaveBeenCalled();
  });
});
