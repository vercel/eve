import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  findCliApplicationRoot,
  resolveCliApplicationRoot,
  type ResolveCliApplicationRootDependencies,
} from "#cli/application-root.js";
import { DiscoveryProjectResolutionError } from "#discover/project.js";
import {
  createDiscoverErrorDiagnostic,
  DISCOVER_PROJECT_NOT_FOUND,
} from "#discover/diagnostics.js";
import type { Prompter } from "#setup/prompter.js";

function projectNotFound(path: string): DiscoveryProjectResolutionError {
  return new DiscoveryProjectResolutionError(
    createDiscoverErrorDiagnostic({
      code: DISCOVER_PROJECT_NOT_FOUND,
      message: `Could not resolve an eve agent root from "${path}".`,
      sourcePath: path,
    }),
  );
}

function dependencies(input: {
  readonly directories?: readonly string[];
  readonly packageRoots?: readonly string[];
  readonly projects?: Readonly<Record<string, { appRoot: string; layout?: "flat" | "nested" }>>;
  readonly select?: (options: unknown) => Promise<string>;
}): ResolveCliApplicationRootDependencies {
  const packageRoots = new Set(input.packageRoots ?? Object.keys(input.projects ?? {}));
  return {
    createPrompter: () => ({ select: input.select ?? vi.fn() }) as Prompter,
    pathExists: vi.fn(async (path) =>
      [...packageRoots].some((root) => path === `${root}/package.json`),
    ),
    readDirectory: vi.fn(async () =>
      (input.directories ?? []).map((name) => ({ name, isDirectory: () => true })),
    ),
    resolveDiscoveryProject: vi.fn(async (path: string | undefined) => {
      const resolvedPath = resolve(path ?? process.cwd());
      const project = input.projects?.[resolvedPath];
      if (project === undefined) throw projectNotFound(resolvedPath);
      return {
        agentRoot: project.layout === "flat" ? project.appRoot : `${project.appRoot}/agent`,
        appRoot: project.appRoot,
        layout: project.layout ?? "nested",
      };
    }),
  };
}

describe("resolveCliApplicationRoot", () => {
  it("uses the application root resolved by project discovery", async () => {
    const deps = dependencies({ projects: { "/repo/agent/tools": { appRoot: "/repo" } } });

    await expect(resolveCliApplicationRoot("/repo/agent/tools", {}, deps)).resolves.toBe("/repo");
    expect(deps.readDirectory).not.toHaveBeenCalled();
  });

  it("finds flat application roots", async () => {
    const deps = dependencies({
      projects: { "/repo/agents/billing": { appRoot: "/repo/agents/billing", layout: "flat" } },
    });

    await expect(findCliApplicationRoot("/repo/agents/billing", deps)).resolves.toBe(
      "/repo/agents/billing",
    );
  });

  it("always asks before using an immediate child application", async () => {
    const select = vi.fn(async () => "/workspace/weather");
    const deps = dependencies({
      directories: ["weather", "notes"],
      projects: { "/workspace/weather": { appRoot: "/workspace/weather" } },
      select,
    });

    await expect(
      resolveCliApplicationRoot("/workspace", { interactive: true }, deps),
    ).resolves.toBe("/workspace/weather");
    expect(select).toHaveBeenCalledWith({
      message: "Which eve application should run this command?",
      options: [{ value: "/workspace/weather", label: "./weather" }],
      initialValue: "/workspace/weather",
    });
  });

  it("excludes a flat-shaped child without an authored package boundary", async () => {
    const select = vi.fn();
    const deps = dependencies({
      directories: ["state-usage"],
      packageRoots: [],
      projects: { "/workspace/state-usage": { appRoot: "/workspace/state-usage", layout: "flat" } },
      select,
    });

    await expect(
      resolveCliApplicationRoot("/workspace", { interactive: true }, deps),
    ).resolves.toBe("/workspace");
    expect(select).not.toHaveBeenCalled();
  });

  it("includes a flat child inside an authored package boundary", async () => {
    const select = vi.fn(async () => "/workspace/billing");
    const deps = dependencies({
      directories: ["billing"],
      packageRoots: ["/workspace"],
      projects: {
        "/workspace/billing": { appRoot: "/workspace/billing", layout: "flat" },
      },
      select,
    });

    await expect(
      resolveCliApplicationRoot("/workspace", { interactive: true }, deps),
    ).resolves.toBe("/workspace/billing");
  });

  it("does not treat a child's enclosing parent application as a child candidate", async () => {
    const deps = dependencies({
      directories: ["nested"],
      projects: { "/workspace/nested": { appRoot: "/workspace" } },
    });

    await expect(
      resolveCliApplicationRoot("/workspace", { interactive: true }, deps),
    ).resolves.toBe("/workspace");
  });

  it("lists child applications instead of choosing non-interactively", async () => {
    const deps = dependencies({
      directories: ["weather"],
      projects: { "/workspace/weather": { appRoot: "/workspace/weather" } },
    });

    await expect(
      resolveCliApplicationRoot("/workspace", { interactive: false }, deps),
    ).rejects.toThrow("Run the command from inside one of these applications:\n  - ./weather");
  });

  it("preserves cwd when no enclosing or immediate-child application exists", async () => {
    const deps = dependencies({ directories: ["packages"] });

    await expect(resolveCliApplicationRoot("./workspace", {}, deps)).resolves.toBe(
      resolve("./workspace"),
    );
  });

  it("does not hide unexpected discovery failures", async () => {
    const deps = dependencies({});
    vi.mocked(deps.resolveDiscoveryProject).mockRejectedValue(new Error("read failed"));

    await expect(resolveCliApplicationRoot("/workspace", {}, deps)).rejects.toThrow("read failed");
  });
});
