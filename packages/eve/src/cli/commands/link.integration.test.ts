import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { ApplyAiGatewayCredentialDeps } from "#setup/boxes/apply-ai-gateway-credential.js";
import type { LinkProjectDeps } from "#setup/boxes/link-project.js";
import type { ResolveProvisioningDeps } from "#setup/boxes/resolve-provisioning.js";
import type { LinkFlowDeps } from "#setup/flows/link.js";
import { isEveProject } from "#setup/scaffold/index.js";

import { runLinkCommand, type LinkCliLogger } from "./link.js";

class TestLogger implements LinkCliLogger {
  readonly errors: string[] = [];
  readonly logs: string[] = [];

  error(message: string): void {
    this.errors.push(message);
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

async function createAgentProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "eve-link-command-"));
  await mkdir(join(projectRoot, "agent"), { recursive: true });
  await writeFile(join(projectRoot, "agent/agent.ts"), "export default {};\n", "utf8");
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "my-agent", dependencies: {} }, null, 2)}\n`,
    "utf8",
  );
  return projectRoot;
}

function createFlowDeps(): Partial<LinkFlowDeps> {
  return {
    detectProjectIdentity: vi.fn(async () => undefined),
    findEnvFileWithKey: vi.fn(async (_root: string, key: string) =>
      key === "VERCEL_OIDC_TOKEN" ? (".env.local" as const) : undefined,
    ),
    resolveProvisioning: {
      requireAuth: vi.fn<ResolveProvisioningDeps["requireAuth"]>(async () => {}),
      isVercelAuthenticated: vi.fn<ResolveProvisioningDeps["isVercelAuthenticated"]>(
        async () => true,
      ),
      detectProjectResolution: vi.fn<ResolveProvisioningDeps["detectProjectResolution"]>(
        async () => ({ kind: "unresolved" }),
      ),
      pathExists: vi.fn<ResolveProvisioningDeps["pathExists"]>(async () => false),
      validateTeam: vi.fn<ResolveProvisioningDeps["validateTeam"]>(async () => {}),
      resolveTeam: vi.fn<ResolveProvisioningDeps["resolveTeam"]>(async () => "acme"),
      pickTeam: vi.fn<ResolveProvisioningDeps["pickTeam"]>(async () => "acme"),
      resolveProjectByNameOrId: vi.fn<ResolveProvisioningDeps["resolveProjectByNameOrId"]>(
        async () => ({
          projectId: "prj_existing",
          projectName: "existing-project",
        }),
      ),
      pickProject: vi.fn<ResolveProvisioningDeps["pickProject"]>(async () => ({
        kind: "existing",
        project: {
          projectId: "prj_1",
          projectName: "my-agent",
        },
        team: "acme",
      })),
      pickNewProjectName: vi.fn<ResolveProvisioningDeps["pickNewProjectName"]>(
        async () => "my-agent",
      ),
      assertNewProjectNameAvailable: vi.fn<
        ResolveProvisioningDeps["assertNewProjectNameAvailable"]
      >(async () => {}),
    },
    linkProject: {
      linkProject: vi.fn<LinkProjectDeps["linkProject"]>(async () => ({
        projectId: "prj_1",
        projectName: "my-agent",
      })),
      detectProjectResolution: vi.fn<LinkProjectDeps["detectProjectResolution"]>(async () => ({
        kind: "linked",
        projectId: "prj_1",
      })),
      unresolvedProject: vi.fn<LinkProjectDeps["unresolvedProject"]>(() => ({
        kind: "unresolved",
      })),
    },
    applyAiGatewayCredential: {
      appendEnv: vi.fn<ApplyAiGatewayCredentialDeps["appendEnv"]>(async () => ({
        written: [],
        skipped: [],
      })),
      runVercelEnvPull: vi.fn<ApplyAiGatewayCredentialDeps["runVercelEnvPull"]>(async () => true),
      detectAiGatewayResolution: vi.fn<ApplyAiGatewayCredentialDeps["detectAiGatewayResolution"]>(
        async () => ({ kind: "api-key", envFile: ".env.local" }),
      ),
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runLinkCommand", () => {
  test("refuses a directory without an eve agent", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "eve-link-empty-"));
    const logger = new TestLogger();

    await runLinkCommand(logger, projectRoot, {
      isEveProject,
      hasInteractiveTerminal: () => true,
    });

    expect(logger.errors).toEqual([
      "No eve agent in this directory. Run `eve init <name>`, then run this command from inside the new project.",
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("refuses without an interactive terminal", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();

    await runLinkCommand(logger, projectRoot, {
      isEveProject,
      hasInteractiveTerminal: () => false,
    });

    expect(logger.errors[0]).toContain("interactive terminal");
    expect(process.exitCode).toBe(1);
  });

  test("links through the shared flow and reports success", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const fake = createFakePrompter({
      single: (opts) => {
        if (opts.message === "Vercel project") return "link";
        throw new Error(`Unexpected select: ${opts.message}`);
      },
    });
    const flowDeps = createFlowDeps();

    await runLinkCommand(logger, projectRoot, {
      createPrompter: () => fake.prompter,
      isEveProject,
      hasInteractiveTerminal: () => true,
      flowDeps,
    });

    expect(logger.errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(fake.prompter.intro).toHaveBeenCalledWith("Link your eve agent to Vercel");
    expect(fake.prompter.outro).toHaveBeenCalledWith("Project linked.");
    expect(flowDeps.linkProject?.linkProject).toHaveBeenCalled();
  });
});
