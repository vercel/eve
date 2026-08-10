import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { runIntegrationConnect, runIntegrationConnectCommand } from "./integration-connect.js";

const { isEveProject } = vi.hoisted(() => ({ isEveProject: vi.fn(async () => true) }));

vi.mock("#setup/scaffold/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/scaffold/index.js")>()),
  isEveProject,
}));

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

  it("requires a linked project without starting the link flow non-interactively", async () => {
    const deps = dependencies({ readProjectLink: vi.fn(async () => undefined) });

    await expect(
      runIntegrationConnect({
        appRoot: "/project",
        slug: "linear",
        service: "mcp.linear.app",
        options: { nonInteractive: true },
        dependencies: deps,
      }),
    ).rejects.toMatchObject({
      prerequisite: expect.objectContaining({ code: "vercel-project-link", command: "eve link" }),
    });
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
    expect(deps.setupConnectionConnector).not.toHaveBeenCalled();
  });

  it("emits a structured linked-project prerequisite non-interactively", async () => {
    const output = {
      errors: [] as string[],
      log: vi.fn(),
      error: vi.fn((message) => output.errors.push(message)),
    };
    const deps = dependencies({ readProjectLink: vi.fn(async () => undefined) });

    await runIntegrationConnectCommand(
      output,
      "/project",
      "linear",
      "mcp.linear.app",
      undefined,
      { nonInteractive: true },
      deps,
    );

    expect(JSON.parse(output.errors[0]!)).toMatchObject({
      type: "blocked",
      status: "prerequisite_required",
      prerequisite: { code: "vercel-project-link", command: "eve link" },
    });
    expect(process.exitCode).toBe(2);
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
