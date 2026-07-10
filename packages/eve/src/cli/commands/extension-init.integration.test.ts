import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectPackageManager } from "#setup/package-manager.js";
import {
  scaffoldExtensionProject,
  type ScaffoldExtensionProjectOptions,
} from "#setup/scaffold/index.js";
import { pathExists } from "#setup/path-exists.js";

import type { GitInitResult } from "./init-git.js";
import {
  EVE_INIT_PACKAGE_SPEC_ENV,
  runExtensionInitCommand,
  type ExtensionInitCliLogger,
  type ExtensionInitCommandDependencies,
} from "./extension-init.js";

const BASE_VERSIONS = {
  evePackage: { version: "0.6.0", nodeEngine: ">=24" },
  typescriptPackageVersion: "7.0.2",
  zodPackageVersion: "4.0.0",
} as const;

function logger(): ExtensionInitCliLogger & { messages: string[]; errors: string[] } {
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
): ExtensionInitCommandDependencies & {
  detectInvokingPackageManager: ReturnType<
    typeof vi.fn<ExtensionInitCommandDependencies["detectInvokingPackageManager"]>
  >;
  isCodingAgentLaunch: ReturnType<
    typeof vi.fn<ExtensionInitCommandDependencies["isCodingAgentLaunch"]>
  >;
  now: ReturnType<typeof vi.fn<ExtensionInitCommandDependencies["now"]>>;
  runPackageManagerInstall: ReturnType<
    typeof vi.fn<ExtensionInitCommandDependencies["runPackageManagerInstall"]>
  >;
  tryInitializeGit: ReturnType<typeof vi.fn<ExtensionInitCommandDependencies["tryInitializeGit"]>>;
} {
  return {
    detectInvokingPackageManager: vi.fn(() => undefined),
    isCodingAgentLaunch: vi.fn(async () => false),
    now: vi.fn(() => 0),
    detectPackageManager,
    scaffoldExtensionProject: (options: ScaffoldExtensionProjectOptions) => {
      const merged = {
        ...options,
        evePackage: options.evePackage ?? BASE_VERSIONS.evePackage,
        typescriptPackageVersion:
          options.typescriptPackageVersion ?? BASE_VERSIONS.typescriptPackageVersion,
        zodPackageVersion: options.zodPackageVersion ?? BASE_VERSIONS.zodPackageVersion,
      };
      return scaffoldExtensionProject(merged);
    },
    runPackageManagerInstall: vi.fn(async () => true),
    tryInitializeGit: vi.fn(async () => gitResult),
  };
}

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

describe("runExtensionInitCommand", () => {
  it("scaffolds an extension package and prints next steps without starting eve dev", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-extension-init-"));
    const output = logger();
    const deps = dependencies();

    await runExtensionInitCommand(output, parentDirectory, "my-crm", deps);

    const projectPath = join(parentDirectory, "my-crm");
    const packageJson = JSON.parse(await readFile(join(projectPath, "package.json"), "utf8")) as {
      eve?: { extension?: string };
      peerDependencies?: { eve?: string };
      devDependencies?: { eve?: string; typescript?: string };
      dependencies?: { zod?: string; ai?: string };
      scripts?: Record<string, string>;
    };
    expect(packageJson.eve?.extension).toBe("./extension");
    expect(packageJson.peerDependencies?.eve).toBe("^0.6.0");
    expect(packageJson.devDependencies?.eve).toBe("^0.6.0");
    expect(packageJson.dependencies?.zod).toBe("4.0.0");
    expect(packageJson.dependencies?.ai).toBeUndefined();
    expect(packageJson.scripts?.build).toBe("eve extension build");
    expect(packageJson.scripts?.prepare).toBe("eve extension build");
    expect(packageJson.scripts?.dev).toBeUndefined();
    expect(await readFile(join(projectPath, "extension/extension.ts"), "utf8")).toContain(
      "defineExtension",
    );
    await expect(pathExists(join(projectPath, "extension/tools"))).resolves.toBe(false);
    await expect(pathExists(join(projectPath, "agent"))).resolves.toBe(false);

    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "pnpm",
      projectPath,
      expect.objectContaining({ bypassMinimumReleaseAge: true }),
    );
    expect(deps.tryInitializeGit).toHaveBeenCalledWith(projectPath);

    const printed = output.messages.join("\n");
    expect(printed).toContain("Created an eve extension in ");
    expect(printed).toContain(projectPath);
    expect(printed).toContain("Initialized Git repository");
    expect(printed).toContain("extension/extension.ts");
    expect(printed).toContain("eve extension build");
    expect(printed).toContain("pnpm run build");
    expect(printed).toContain("agent/extensions/my-crm.ts");
    expect(printed).not.toContain("eve dev");
  });

  it("scaffolds an extension for a coding agent with a named target", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-extension-init-agent-"));
    const output = logger();
    const deps = dependencies();
    deps.isCodingAgentLaunch.mockResolvedValue(true);

    await runExtensionInitCommand(output, parentDirectory, "my-crm", deps);

    const projectPath = join(parentDirectory, "my-crm");
    await expect(pathExists(join(projectPath, "extension/extension.ts"))).resolves.toBe(true);
    expect(deps.runPackageManagerInstall).toHaveBeenCalled();
    expect(deps.tryInitializeGit).toHaveBeenCalledWith(projectPath);
    const printed = output.messages.join("\n");
    expect(printed).toContain("Created an eve extension in ");
    expect(printed).toContain("What we set up:");
    expect(printed).not.toContain("Set up an eve agent");
  });

  it("hands a coding agent the extension setup guide when the target is omitted", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-extension-init-bare-"));
    const output = logger();
    const deps = dependencies();
    deps.isCodingAgentLaunch.mockResolvedValue(true);

    await runExtensionInitCommand(output, parentDirectory, undefined, deps);

    await expect(pathExists(join(parentDirectory, "extension"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
    expect(deps.tryInitializeGit).not.toHaveBeenCalled();
    const printed = output.messages.join("\n");
    expect(printed).toContain("npx eve@latest extension init <name>");
    expect(printed).toContain("does not start eve dev");
    expect(printed).toContain("eve extension build");
  });

  it("rejects an existing project with package.json", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-extension-init-existing-"));
    const projectRoot = await createHostProject(parentDirectory);
    const output = logger();
    const deps = dependencies();

    await expect(
      runExtensionInitCommand(output, parentDirectory, "host-app", deps),
    ).rejects.toThrow("cannot add to an existing project");

    await expect(pathExists(join(projectRoot, "extension"))).resolves.toBe(false);
    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
  });

  it("honors EVE_INIT_PACKAGE_SPEC for peer and dev eve deps", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "eve-extension-init-spec-"));
    const output = logger();
    const deps = dependencies();
    vi.stubEnv(EVE_INIT_PACKAGE_SPEC_ENV, "file:/tmp/eve-local.tgz");

    await runExtensionInitCommand(output, parentDirectory, "my-crm", deps);

    const packageJson = JSON.parse(
      await readFile(join(parentDirectory, "my-crm", "package.json"), "utf8"),
    ) as {
      peerDependencies?: { eve?: string };
      devDependencies?: { eve?: string };
    };
    expect(packageJson.peerDependencies?.eve).toBe("file:/tmp/eve-local.tgz");
    expect(packageJson.devDependencies?.eve).toBe("file:/tmp/eve-local.tgz");
  });
});
