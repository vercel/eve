import { describe, expect, it, vi } from "vitest";

import {
  resolveCliApplicationRoot,
  type ResolveCliApplicationRootDependencies,
} from "#cli/application-root.js";
import type { Prompter } from "#setup/prompter.js";

function dependencies(input: {
  readonly directories?: readonly string[];
  readonly projects?: readonly string[];
  readonly select?: (options: unknown) => Promise<string>;
}): ResolveCliApplicationRootDependencies {
  const directories = input.directories ?? [];
  const projects = new Set(input.projects ?? []);
  return {
    createPrompter: () =>
      ({
        select: input.select ?? vi.fn(),
      }) as Prompter,
    isEveProject: async (path) => projects.has(path),
    readDirectory: vi.fn(async () =>
      directories.map((name) => ({
        name,
        isDirectory: () => true,
      })),
    ),
  };
}

describe("resolveCliApplicationRoot", () => {
  it("uses the current application root without prompting", async () => {
    const select = vi.fn();
    const deps = dependencies({ projects: ["/repo"], select });

    await expect(resolveCliApplicationRoot("/repo", { interactive: true }, deps)).resolves.toBe(
      "/repo",
    );
    expect(select).not.toHaveBeenCalled();
    expect(deps.readDirectory).not.toHaveBeenCalled();
  });

  it("uses the nearest ancestor application root", async () => {
    const deps = dependencies({ projects: ["/repo", "/repo/apps/agent"] });

    await expect(
      resolveCliApplicationRoot("/repo/apps/agent/agent/tools", { interactive: true }, deps),
    ).resolves.toBe("/repo/apps/agent");
    expect(deps.readDirectory).not.toHaveBeenCalled();
  });

  it("asks before using a sole immediate child application", async () => {
    const select = vi.fn(async () => "/workspace/weather");
    const deps = dependencies({
      directories: ["weather", "notes"],
      projects: ["/workspace/weather"],
      select,
    });

    await expect(
      resolveCliApplicationRoot("/workspace", { interactive: true }, deps),
    ).resolves.toBe("/workspace/weather");
    expect(select).toHaveBeenCalledWith({
      message: "Which eve application should run this command?",
      description: "Found eve applications in immediate subdirectories.",
      options: [{ value: "/workspace/weather", label: "./weather" }],
      initialValue: "/workspace/weather",
    });
  });

  it("sorts multiple immediate child applications in the prompt", async () => {
    const select = vi.fn(async () => "/workspace/alpha");
    const deps = dependencies({
      directories: ["zulu", "alpha"],
      projects: ["/workspace/alpha", "/workspace/zulu"],
      select,
    });

    await resolveCliApplicationRoot("/workspace", { interactive: true }, deps);

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          { value: "/workspace/alpha", label: "./alpha" },
          { value: "/workspace/zulu", label: "./zulu" },
        ],
      }),
    );
  });

  it("lists child applications instead of choosing in a non-interactive terminal", async () => {
    const deps = dependencies({
      directories: ["weather"],
      projects: ["/workspace/weather"],
    });

    await expect(
      resolveCliApplicationRoot("/workspace", { interactive: false }, deps),
    ).rejects.toThrow("Run the command from inside one of these applications:\n  - ./weather");
  });

  it("fails when no ancestor or immediate child is an application", async () => {
    const deps = dependencies({ directories: ["packages"] });

    await expect(
      resolveCliApplicationRoot("/workspace", { interactive: true }, deps),
    ).rejects.toThrow(
      "No eve application found in this directory, its ancestors, or its immediate subdirectories.",
    );
  });
});
