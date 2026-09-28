import { describe, expect, it, vi } from "vitest";

import { findCliApplicationRoot, resolveCliApplicationProject } from "#cli/application-root.js";
import {
  createDiscoverErrorDiagnostic,
  DISCOVER_PROJECT_NOT_FOUND,
} from "#discover/diagnostics.js";
import { DiscoveryProjectResolutionError, resolveDiscoveryProject } from "#discover/project.js";

vi.mock("#discover/project.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#discover/project.js")>()),
  resolveDiscoveryProject: vi.fn(),
}));

const resolveDiscoveryProjectMock = vi.mocked(resolveDiscoveryProject);

function projectNotFound(path: string): DiscoveryProjectResolutionError {
  return new DiscoveryProjectResolutionError(
    createDiscoverErrorDiagnostic({
      code: DISCOVER_PROJECT_NOT_FOUND,
      message: `Could not resolve an eve agent root from "${path}".`,
      sourcePath: path,
    }),
  );
}

describe("CLI application root", () => {
  it("returns the complete project resolved by discovery", async () => {
    const project = {
      agentRoot: "/repo/agent",
      appRoot: "/repo",
      layout: "nested" as const,
    };
    resolveDiscoveryProjectMock.mockResolvedValueOnce(project);

    await expect(resolveCliApplicationProject("/repo/agent/tools")).resolves.toEqual(project);
  });

  it("finds a named agent workspace member", async () => {
    resolveDiscoveryProjectMock.mockResolvedValueOnce({
      agentRoot: "/repo/agents/billing/agent",
      appRoot: "/repo/agents/billing",
      layout: "nested",
    });

    await expect(findCliApplicationRoot("/repo/agents/billing/tools")).resolves.toBe(
      "/repo/agents/billing",
    );
  });

  it("finds flat application roots", async () => {
    resolveDiscoveryProjectMock.mockResolvedValueOnce({
      agentRoot: "/repo/agents/billing",
      appRoot: "/repo/agents/billing",
      layout: "flat",
    });

    await expect(findCliApplicationRoot("/repo/agents/billing")).resolves.toBe(
      "/repo/agents/billing",
    );
  });

  it("returns undefined when finding from outside an application", async () => {
    resolveDiscoveryProjectMock.mockImplementationOnce(async (path) => {
      throw projectNotFound(path ?? process.cwd());
    });

    await expect(findCliApplicationRoot("/workspace/packages")).resolves.toBeUndefined();
  });

  it("does not hide unexpected discovery failures", async () => {
    resolveDiscoveryProjectMock.mockRejectedValueOnce(new Error("read failed"));

    await expect(findCliApplicationRoot("/workspace")).rejects.toThrow("read failed");
  });
});
