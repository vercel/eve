import { describe, expect, it, vi } from "vitest";

import { findCliApplicationRoot, resolveCliApplicationRoot } from "#cli/application-root.js";

function dependencies(projects: readonly string[]) {
  const knownProjects = new Set(projects);
  return { isEveProject: vi.fn(async (path: string) => knownProjects.has(path)) };
}

describe("resolveCliApplicationRoot", () => {
  it("uses the current application root", async () => {
    const deps = dependencies(["/repo"]);

    await expect(resolveCliApplicationRoot("/repo", deps)).resolves.toBe("/repo");
    expect(deps.isEveProject).toHaveBeenCalledTimes(1);
  });

  it("uses the nearest ancestor application root", async () => {
    const deps = dependencies(["/repo", "/repo/apps/agent"]);

    await expect(resolveCliApplicationRoot("/repo/apps/agent/agent/tools", deps)).resolves.toBe(
      "/repo/apps/agent",
    );
    expect(deps.isEveProject.mock.calls.map(([path]) => path)).toEqual([
      "/repo/apps/agent/agent/tools",
      "/repo/apps/agent/agent",
      "/repo/apps/agent",
    ]);
  });

  it("returns undefined when finding from outside an application", async () => {
    const deps = dependencies([]);

    await expect(findCliApplicationRoot("/workspace/packages", deps)).resolves.toBeUndefined();
  });

  it("fails when resolving from outside an application", async () => {
    const deps = dependencies([]);

    await expect(resolveCliApplicationRoot("/workspace/packages", deps)).rejects.toThrow(
      "No eve application found in this directory or its ancestors.",
    );
  });
});
