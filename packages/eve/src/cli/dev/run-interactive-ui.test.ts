import { describe, expect, it, vi } from "vitest";

import type { EveProjectContext } from "#internal/project-context.js";

const { findEveProjectContext } = vi.hoisted(() => ({
  findEveProjectContext: vi.fn<() => Promise<EveProjectContext | undefined>>(),
}));

vi.mock("#internal/project-context.js", () => ({ findEveProjectContext }));
vi.mock("#services/dev-client/runtime-artifacts.js", () => ({
  resumeDevelopmentRuntimeArtifacts: vi.fn(),
  suspendDevelopmentRuntimeArtifacts: vi.fn(),
}));

import { runInteractiveDevelopmentUi } from "./run-interactive-ui.js";

describe("runInteractiveDevelopmentUi", () => {
  it("preserves the selected workspace member when the server owns the workspace root", async () => {
    const memberRoot = "/workspace/agents/bar";
    findEveProjectContext.mockResolvedValue({
      environmentRoot: "/workspace",
      kind: "workspace-member",
      member: { appRoot: memberRoot, name: "bar" },
      workspace: {
        root: "/workspace",
        members: [{ appRoot: memberRoot, name: "bar" }],
      },
    });
    const runDevelopmentTui = vi.fn(async () => {});

    await runInteractiveDevelopmentUi({
      applicationRoot: memberRoot,
      existingLocalServer: false,
      options: {},
      runDevelopmentTui,
      server: { appRoot: "/workspace", serverUrl: "http://localhost:2000" },
    });

    expect(findEveProjectContext).toHaveBeenCalledWith(memberRoot);
    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          agentRoot: memberRoot,
          kind: "local",
          serverUrl: "http://localhost:2000",
          workspaceRoot: "/workspace",
        },
      }),
    );
  });
});
