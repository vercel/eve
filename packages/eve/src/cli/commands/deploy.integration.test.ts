import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { DeployProjectDeps } from "#setup/boxes/deploy-project.js";
import type { DeploymentInfo } from "#setup/project-resolution.js";
import { isEveProject } from "#setup/scaffold/index.js";

import { runDeployCommand, type DeployCliLogger } from "./deploy.js";

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

async function createAgentProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "eve-deploy-command-"));
  await mkdir(join(projectRoot, "agent"), { recursive: true });
  await writeFile(join(projectRoot, "agent/agent.ts"), "export default {};\n", "utf8");
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "my-agent", dependencies: {} }, null, 2)}\n`,
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
    runPackageManagerInstall: vi.fn<DeployProjectDeps["runPackageManagerInstall"]>(
      async () => true,
    ),
    detectDeployment: vi.fn<DeployProjectDeps["detectDeployment"]>(async () => DEPLOYED),
  };
}

afterEach(() => {
  process.exitCode = undefined;
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

  test("points an unlinked non-interactive run at eve link", async () => {
    const projectRoot = await createAgentProject();
    const logger = new TestLogger();
    const fake = createFakePrompter({});
    const deployDeps = createDeployProjectDeps();

    await runDeployCommand(logger, projectRoot, {
      createPrompter: () => fake.prompter,
      isEveProject,
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
      isEveProject,
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
});
