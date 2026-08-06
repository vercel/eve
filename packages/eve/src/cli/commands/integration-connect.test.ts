import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { runIntegrationConnect } from "./integration-connect.js";

const PROJECT = { orgId: "team_1", projectId: "prj_1" };

function dependencies(overrides: Record<string, unknown> = {}) {
  const fake = createFakePrompter();
  return {
    createPrompter: () => fake.prompter,
    readProjectLink: vi.fn(async () => PROJECT),
    runLinkFlow: vi.fn(async () => ({ kind: "done" as const })),
    setupConnectionConnector: vi.fn(async () => ({
      kind: "existing" as const,
      connectorUid: "linear/real",
    })),
    cleanupCreatedConnectionConnector: vi.fn(async () => {}),
    updateConnectionConnectorUid: vi.fn(async () => ({ patched: true })),
    ...overrides,
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runIntegrationConnect", () => {
  it("provisions and patches an installed connection", async () => {
    const deps = dependencies();
    await runIntegrationConnect({
      appRoot: "/project",
      slug: "linear",
      service: "mcp.linear.app",
      dependencies: deps,
    });

    expect(deps.setupConnectionConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "linear",
        service: "mcp.linear.app",
        canonicalConnectorName: "linear",
        project: PROJECT,
      }),
    );
    expect(deps.updateConnectionConnectorUid).toHaveBeenCalledWith(
      "/project/agent/connections/linear.ts",
      "linear/real",
    );
  });

  it("links an unlinked project before connector setup", async () => {
    const readProjectLink = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(PROJECT);
    const deps = dependencies({ readProjectLink });

    await runIntegrationConnect({
      appRoot: "/project",
      slug: "linear",
      service: "mcp.linear.app",
      dependencies: deps,
    });

    expect(deps.runLinkFlow).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot: "/project", projectSelection: "create-or-link" }),
    );
  });

  it("cleans up a newly-created connector when the installed file cannot be patched", async () => {
    const deps = dependencies({
      setupConnectionConnector: vi.fn(async () => ({
        kind: "created" as const,
        connectorUid: "linear/new",
        connectorId: "scl_new",
      })),
      updateConnectionConnectorUid: vi.fn(async () => ({ patched: false })),
    });

    await expect(
      runIntegrationConnect({
        appRoot: "/project",
        slug: "linear",
        service: "mcp.linear.app",
        dependencies: deps,
      }),
    ).rejects.toThrow("Could not update the connector");
    expect(deps.cleanupCreatedConnectionConnector).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: "scl_new", orgId: "team_1" }),
    );
  });
});
