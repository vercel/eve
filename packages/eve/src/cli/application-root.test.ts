import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  findCliApplicationRoot,
  resolveCliApplicationRoot,
  type ResolveCliApplicationRootDependencies,
} from "#cli/application-root.js";
import {
  createDiscoverErrorDiagnostic,
  DISCOVER_PROJECT_NOT_FOUND,
} from "#discover/diagnostics.js";
import { DiscoveryProjectResolutionError } from "#discover/project.js";

function projectNotFound(path: string): DiscoveryProjectResolutionError {
  return new DiscoveryProjectResolutionError(
    createDiscoverErrorDiagnostic({
      code: DISCOVER_PROJECT_NOT_FOUND,
      message: `Could not resolve an eve agent root from "${path}".`,
      sourcePath: path,
    }),
  );
}

function dependencies(
  implementation: ResolveCliApplicationRootDependencies["resolveDiscoveryProject"],
): ResolveCliApplicationRootDependencies {
  return { resolveDiscoveryProject: vi.fn(implementation) };
}

describe("resolveCliApplicationRoot", () => {
  it("uses the application root resolved by project discovery", async () => {
    const deps = dependencies(async () => ({
      agentRoot: "/repo/agent",
      appRoot: "/repo",
      layout: "nested",
    }));

    await expect(resolveCliApplicationRoot("/repo/agent/tools", deps)).resolves.toBe("/repo");
  });

  it("finds flat application roots", async () => {
    const deps = dependencies(async () => ({
      agentRoot: "/repo/agents/billing",
      appRoot: "/repo/agents/billing",
      layout: "flat",
    }));

    await expect(findCliApplicationRoot("/repo/agents/billing", deps)).resolves.toBe(
      "/repo/agents/billing",
    );
  });

  it("returns undefined when finding from outside an application", async () => {
    const deps = dependencies(async (path) => {
      throw projectNotFound(path ?? process.cwd());
    });

    await expect(findCliApplicationRoot("/workspace/packages", deps)).resolves.toBeUndefined();
  });

  it("preserves cwd when resolving from outside an application", async () => {
    const deps = dependencies(async (path) => {
      throw projectNotFound(path ?? process.cwd());
    });

    await expect(resolveCliApplicationRoot("./workspace/packages", deps)).resolves.toBe(
      resolve("./workspace/packages"),
    );
  });

  it("does not hide unexpected discovery failures", async () => {
    const deps = dependencies(async () => {
      throw new Error("read failed");
    });

    await expect(resolveCliApplicationRoot("/workspace", deps)).rejects.toThrow("read failed");
  });
});
