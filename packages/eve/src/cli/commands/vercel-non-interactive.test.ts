import { afterEach, describe, expect, test, vi } from "vitest";

import {
  runNonInteractiveLink,
  type NonInteractiveLinkDependencies,
} from "./vercel-non-interactive.js";

class TestLogger {
  readonly errors: string[] = [];
  readonly logs: string[] = [];

  error(message: string): void {
    this.errors.push(message);
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

function dependencies(): NonInteractiveLinkDependencies {
  return {
    isEveProject: vi.fn(async () => true),
    runVercel: vi.fn(async () => true),
    runVercelEnvPull: vi.fn(async () => true),
    readProjectLink: vi.fn(async () => ({
      orgId: "team_a",
      projectId: "prj_new",
      projectName: "wayfinder",
    })),
    resolveTeam: vi.fn(async () => "acme"),
    resolveProjectByNameOrId: vi.fn(async () => null),
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runNonInteractiveLink", () => {
  test("requires the project Vercel requires for a non-interactive link", async () => {
    const logger = new TestLogger();
    const deps = dependencies();

    await runNonInteractiveLink({
      logger,
      appRoot: "/agent",
      options: { nonInteractive: true },
      dependencies: deps,
    });

    expect(logger.errors).toEqual([
      "`eve link --non-interactive` requires `--project <name-or-id>`.",
    ]);
    expect(deps.runVercel).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("links the selected project and pulls its environment without stdin", async () => {
    const logger = new TestLogger();
    const deps = dependencies();

    await runNonInteractiveLink({
      logger,
      appRoot: "/agent",
      options: { nonInteractive: true, project: "wayfinder", team: "acme" },
      dependencies: deps,
    });

    expect(deps.runVercel).toHaveBeenCalledWith(
      ["link", "--project", "wayfinder", "--team", "acme", "--yes"],
      { cwd: "/agent", nonInteractive: true },
    );
    expect(deps.runVercelEnvPull).toHaveBeenCalledWith("/agent", undefined, undefined, true);
    expect(logger.logs).toEqual(["Project linked."]);
    expect(deps.resolveProjectByNameOrId).not.toHaveBeenCalled();
  });
  test("reports a newly created project after checking the link scope", async () => {
    const deps = dependencies();
    const onCreatedProject = vi.fn(async () => {});

    await runNonInteractiveLink({
      logger: new TestLogger(),
      appRoot: "/agent",
      options: { nonInteractive: true, project: "wayfinder", team: "acme" },
      dependencies: deps,
      onCreatedProject,
    });

    expect(deps.resolveTeam).toHaveBeenCalledWith("/agent", "acme");
    expect(deps.resolveProjectByNameOrId).toHaveBeenCalledWith("/agent", "acme", "wayfinder");
    expect(vi.mocked(deps.resolveProjectByNameOrId).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.runVercel).mock.invocationCallOrder[0]!,
    );
    expect(onCreatedProject).toHaveBeenCalledWith({
      orgId: "team_a",
      projectId: "prj_new",
      projectName: "wayfinder",
    });
  });
  test("does not report an existing project as created", async () => {
    const deps = dependencies();
    vi.mocked(deps.resolveProjectByNameOrId).mockResolvedValue({
      projectId: "prj_existing",
      projectName: "wayfinder",
    });
    const onCreatedProject = vi.fn(async () => {});

    await runNonInteractiveLink({
      logger: new TestLogger(),
      appRoot: "/agent",
      options: { nonInteractive: true, project: "wayfinder" },
      dependencies: deps,
      onCreatedProject,
    });

    expect(onCreatedProject).not.toHaveBeenCalled();
    expect(deps.readProjectLink).not.toHaveBeenCalled();
  });

  test("links without configuring sampling if the scoped existence check fails", async () => {
    const deps = dependencies();
    vi.mocked(deps.resolveProjectByNameOrId).mockRejectedValue(new Error("Access denied"));
    const onCreatedProject = vi.fn(async () => {});
    const onProjectCreationUnknown = vi.fn();

    await expect(
      runNonInteractiveLink({
        logger: new TestLogger(),
        appRoot: "/agent",
        options: { nonInteractive: true, project: "wayfinder" },
        dependencies: deps,
        onCreatedProject,
        onProjectCreationUnknown,
      }),
    ).resolves.toBe(true);

    expect(deps.runVercel).toHaveBeenCalled();
    expect(onCreatedProject).not.toHaveBeenCalled();
    expect(onProjectCreationUnknown).toHaveBeenCalledOnce();
  });

  test("continues linking when project metadata is unavailable for sampling", async () => {
    const deps = dependencies();
    vi.mocked(deps.readProjectLink).mockResolvedValue(undefined);
    const onCreatedProject = vi.fn(async () => {});
    const onProjectCreationUnknown = vi.fn();

    await expect(
      runNonInteractiveLink({
        logger: new TestLogger(),
        appRoot: "/agent",
        options: { nonInteractive: true, project: "wayfinder" },
        dependencies: deps,
        onCreatedProject,
        onProjectCreationUnknown,
      }),
    ).resolves.toBe(true);

    expect(deps.runVercelEnvPull).toHaveBeenCalled();
    expect(onCreatedProject).not.toHaveBeenCalled();
    expect(onProjectCreationUnknown).toHaveBeenCalledOnce();
  });
});
