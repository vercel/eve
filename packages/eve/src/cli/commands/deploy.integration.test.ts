import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { packageInstallResult } from "#internal/testing/package-process.js";
import { readVercelCliToken } from "#internal/model-auth/vercel-cli.js";
import type { DeployProjectDeps } from "#setup/boxes/deploy-project.js";
import type { LinkProjectDeps } from "#setup/boxes/link-project.js";
import type { ResolveProvisioningDeps } from "#setup/boxes/resolve-provisioning.js";
import type { DeploymentInfo } from "#setup/project-resolution.js";
import { isEveProject } from "#setup/scaffold/index.js";

import { runDeployCommand, type DeployCliLogger } from "./deploy.js";
import type { NonInteractiveLinkDependencies } from "./vercel-non-interactive.js";

vi.mock("#internal/model-auth/vercel-cli.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#internal/model-auth/vercel-cli.js")>();
  return { ...original, readVercelCliToken: vi.fn(async () => "vercel-token") };
});

class TestLogger implements DeployCliLogger {
  readonly errors: string[] = [];
  readonly logs: string[] = [];

  error(message: string): void {
    this.errors.push(message);
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

async function createWorkspaceProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "eve-deploy-workspace-"));
  await mkdir(join(projectRoot, "agents/support/agent"), { recursive: true });
  await writeFile(
    join(projectRoot, "package.json"),
    JSON.stringify({ dependencies: { eve: "*" }, private: true }),
    "utf8",
  );
  return projectRoot;
}

async function createAgentProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "eve-deploy-command-"));
  await mkdir(join(projectRoot, "agent"), { recursive: true });
  await writeFile(join(projectRoot, "agent/agent.ts"), "export default {};\n", "utf8");
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "my-agent", dependencies: { eve: "*" } }, null, 2)}\n`,
    "utf8",
  );
  return projectRoot;
}

const LINKED: DeploymentInfo = { state: "linked", projectId: "prj_1", orgId: "org_1" };
const DEPLOYED: DeploymentInfo = {
  state: "deployed",
  projectId: "prj_1",
  productionUrl: "https://my-agent.vercel.app",
};

function createDeployProjectDeps() {
  return {
    runVercel: vi.fn<DeployProjectDeps["runVercel"]>(async () => true),
    detectPackageManager: vi.fn<DeployProjectDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "default",
    })),
    runPackageManagerInstall: vi.fn<DeployProjectDeps["runPackageManagerInstall"]>(async () =>
      packageInstallResult(),
    ),
    detectDeployment: vi.fn<DeployProjectDeps["detectDeployment"]>(async () => DEPLOYED),
    syncHostFrameworkPreset: vi.fn<DeployProjectDeps["syncHostFrameworkPreset"]>(async () => {}),
  };
}

function createNonInteractiveLinkDeps(): NonInteractiveLinkDependencies {
  return {
    isEveProject: vi.fn(async () => true),
    runVercel: vi.fn(async () => true),
    runVercelEnvPull: vi.fn(async () => true),
    readProjectLink: vi.fn(async () => ({
      orgId: "team_123",
      projectId: "prj_new",
      projectName: "my-agent",
    })),
    resolveTeam: vi.fn(async () => "acme"),
    resolveProjectByNameOrId: vi.fn(async () => null),
  };
}

function createInteractiveLinkDeps() {
  return {
    linkProject: vi.fn<LinkProjectDeps["linkProject"]>(async () => ({
      projectId: "prj_new",
      projectName: "my-agent",
    })),
    detectProjectResolution: vi.fn<LinkProjectDeps["detectProjectResolution"]>(async () => ({
      kind: "linked",
      projectId: "prj_new",
    })),
    unresolvedProject: vi.fn<LinkProjectDeps["unresolvedProject"]>(() => ({ kind: "unresolved" })),
  };
}

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllGlobals();
});

describe("runDeployCommand", () => {
  test("refuses a directory without an eve agent", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "eve-deploy-empty-"));
    const logger = new TestLogger();

    await runDeployCommand(logger, projectRoot, {
      isEveProject,
      hasInteractiveTerminal: () => true,
    });

    expect(logger.errors).toEqual([
      "No eve agent in this directory. Run `eve init <name>`, then run this command from inside the new project.",
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("refuses to deploy one member of a workspace", async () => {
    const projectRoot = await createWorkspaceProject();
    const logger = new TestLogger();

    await runDeployCommand(logger, join(projectRoot, "agents/support"), {
      isEveProject,
      hasInteractiveTerminal: () => true,
    });

    expect(logger.errors[0]).toContain("workspace root");
    expect(process.exitCode).toBe(1);
  });

  test("points an unlinked non-interactive run at eve link", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const fake = createFakePrompter({});
    const deployDeps = createDeployProjectDeps();

    await runDeployCommand(logger, projectRoot, {
      createPrompter: () => fake.prompter,
      hasInteractiveTerminal: () => false,
      flowDeps: {
        detectDeployment: vi.fn(async () => ({ state: "unlinked" }) as DeploymentInfo),
        deployProject: deployDeps,
      },
    });

    expect(logger.errors[0]).toContain("Run `eve link` first");
    expect(process.exitCode).toBe(1);
    expect(deployDeps.runVercel).not.toHaveBeenCalled();
  });

  test("deploys a linked project headlessly and reports the production URL", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const fake = createFakePrompter({});
    const deployDeps = createDeployProjectDeps();

    await runDeployCommand(logger, projectRoot, {
      createPrompter: () => fake.prompter,
      hasInteractiveTerminal: () => false,
      flowDeps: {
        detectDeployment: vi.fn(async () => LINKED),
        deployProject: deployDeps,
      },
    });

    expect(logger.errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(deployDeps.runVercel).toHaveBeenCalledWith(
      ["deploy", "--prod", "--yes", "--non-interactive"],
      expect.objectContaining({ nonInteractive: true }),
    );
    expect(fake.prompter.outro).toHaveBeenCalledWith("Deployed: https://my-agent.vercel.app");
  });

  test.each([
    { traceSampling: undefined, expected: true },
    { traceSampling: false, expected: false },
  ])(
    "passes the deploy tracing default to interactive linking",
    async ({ traceSampling, expected }) => {
      const projectRoot = await createAgentProject();
      const fake = createFakePrompter({
        single: (opts) => {
          if (opts.message === "Vercel project") return "new";
          throw new Error(`Unexpected select: ${opts.message}`);
        },
      });
      const linkDeps = createInteractiveLinkDeps();
      const provisioningDeps: ResolveProvisioningDeps = {
        requireAuth: vi.fn(async () => {}),
        isVercelAuthenticated: vi.fn(async () => true),
        detectProjectResolution: vi.fn<ResolveProvisioningDeps["detectProjectResolution"]>(
          async () => ({ kind: "unresolved" }),
        ),
        pathExists: vi.fn(async () => false),
        validateTeam: vi.fn(async () => {}),
        resolveTeam: vi.fn(async () => "acme"),
        pickTeam: vi.fn(async () => "acme"),
        pickProject: vi.fn<ResolveProvisioningDeps["pickProject"]>(async () => ({
          kind: "new",
          project: "my-agent",
          team: "acme",
        })),
        resolveProjectByNameOrId: vi.fn(async () => null),
        pickNewProjectName: vi.fn(async () => "my-agent"),
        assertNewProjectNameAvailable: vi.fn(async () => {}),
      };
      const logger = new TestLogger();

      await runDeployCommand(
        logger,
        projectRoot,
        {
          createPrompter: () => fake.prompter,
          hasInteractiveTerminal: () => true,
          flowDeps: {
            detectDeployment: vi.fn(async () => ({ state: "unlinked" as const })),
            runLoginFlow: vi.fn(async () => ({ kind: "already" as const })),
            resolveProvisioning: provisioningDeps,
            linkProject: linkDeps,
            deployProject: createDeployProjectDeps(),
          },
        },
        { traceSampling },
      );

      expect(logger.errors).toEqual([]);
      expect(linkDeps.linkProject).toHaveBeenCalledWith(
        fake.prompter,
        projectRoot,
        expect.objectContaining({ kind: "new" }),
        expect.any(Function),
        { signal: undefined, traceSampling: expected },
      );
    },
  );

  test.each([
    { existing: false, traceSampling: undefined, shouldConfigure: true },
    { existing: false, traceSampling: false, shouldConfigure: false },
    { existing: true, traceSampling: undefined, shouldConfigure: false },
    { existing: "unknown", traceSampling: undefined, shouldConfigure: false },
  ])(
    "non-interactive deploy: existing=$existing traceSampling=$traceSampling",
    async ({ existing, traceSampling, shouldConfigure }) => {
      const projectRoot = await createAgentProject();
      const logger = new TestLogger();
      const fake = createFakePrompter({});
      const linkDeps = createNonInteractiveLinkDeps();
      if (existing === true) {
        vi.mocked(linkDeps.resolveProjectByNameOrId).mockResolvedValue({
          projectId: "prj_existing",
          projectName: "my-agent",
        });
      } else if (existing === "unknown") {
        vi.mocked(linkDeps.resolveProjectByNameOrId).mockRejectedValue(
          new Error("Vercel API unavailable"),
        );
      }
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const deployDeps = createDeployProjectDeps();

      await runDeployCommand(
        logger,
        projectRoot,
        {
          createPrompter: () => fake.prompter,
          hasInteractiveTerminal: () => false,
          nonInteractiveLinkDeps: linkDeps,
          flowDeps: {
            detectDeployment: vi.fn(async () => LINKED),
            deployProject: deployDeps,
          },
        },
        { nonInteractive: true, project: "my-agent", yes: true, traceSampling },
      );

      expect(logger.errors).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expect(deployDeps.runVercel).toHaveBeenCalled();
      if (shouldConfigure) {
        expect(readVercelCliToken).toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledWith(
          "https://api.vercel.com/v1/drains/tracing/config?projectId=prj_new&teamId=team_123",
          expect.objectContaining({ method: "PUT" }),
        );
      } else {
        expect(fetchMock).not.toHaveBeenCalled();
      }
      if (traceSampling === false) {
        expect(linkDeps.resolveProjectByNameOrId).not.toHaveBeenCalled();
      }
      if (existing === "unknown") {
        expect(fake.prompter.log.warning).toHaveBeenCalledWith(
          expect.stringContaining("so it was not configured"),
        );
      } else {
        expect(fake.prompter.log.warning).not.toHaveBeenCalled();
      }
    },
  );
});
