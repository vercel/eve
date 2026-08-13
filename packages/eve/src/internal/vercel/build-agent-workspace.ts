import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentWorkspace } from "#internal/agent-workspace.js";
import { assembleEveVercelServices } from "#internal/vercel/assemble-eve-services.js";
import { quoteVercelShellArgument, toVercelRelativePath } from "#internal/vercel/build-command.js";
import { resolveAgentWorkspaceDeploymentMode } from "#internal/vercel/agent-workspace-deployment.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";

const VERCEL_BUILD_OUTPUT_VERSION = 3;

function resolveMemberBuildCommand(appRoot: string): string {
  return `node ${quoteVercelShellArgument(
    toVercelRelativePath(appRoot, resolveEveBinaryPath(appRoot)),
  )} build`;
}

/** Emit the inferred Vercel Services project for a strict hostless workspace. */
export async function buildAgentWorkspace(workspace: AgentWorkspace): Promise<string> {
  if ((await resolveAgentWorkspaceDeploymentMode(workspace)) === "authored") {
    throw new Error(
      "This project defines its Vercel service graph in vercel.json. Run `vercel build` to build the complete project, or run `eve build` from an individual agent directory.",
    );
  }

  const agents = workspace.members.map((member) => ({
    agent: {
      appRoot: member.appRoot,
      buildCommand: resolveMemberBuildCommand(member.appRoot),
      name: member.name,
      publicRoutePrefix: `/eve/agents/${member.name}`,
    },
    target: {
      hostOutputDirectory: join(workspace.root, ".vercel", "output"),
      projectRoot: workspace.root,
    },
  }));
  const assembled = assembleEveVercelServices({ agents });

  const outputDirectory = join(workspace.root, ".vercel", "output");
  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    assembled.rootDirectories.map(async (rootDirectory) => {
      await mkdir(join(rootDirectory, ".vercel"), { recursive: true });
      await symlink(outputDirectory, join(rootDirectory, ".vercel", "output"), "junction");
    }),
  );
  await writeFile(
    join(outputDirectory, "config.json"),
    `${JSON.stringify(
      {
        version: VERCEL_BUILD_OUTPUT_VERSION,
        routes: assembled.routes,
        services: assembled.services,
      },
      null,
      2,
    )}\n`,
  );
  return outputDirectory;
}
