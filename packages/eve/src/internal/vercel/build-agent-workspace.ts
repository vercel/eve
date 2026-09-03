import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH,
  VERCEL_EVE_MULTI_AGENT_SUMMARY_KIND,
  VERCEL_EVE_MULTI_AGENT_SUMMARY_OUTPUT_PATH,
  VERCEL_EVE_MULTI_AGENT_SUMMARY_VERSION,
  type VercelEveMultiAgentSummary,
} from "#internal/vercel-agent-summary.js";
import type { AgentWorkspace } from "#internal/project-context.js";
import { assembleEveVercelServices } from "#internal/vercel/assemble-eve-services.js";
import { quoteVercelShellArgument, toVercelRelativePath } from "#internal/vercel/build-command.js";
import { readVercelJsonFile } from "#internal/vercel/vercel-services-config.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";

const VERCEL_BUILD_OUTPUT_VERSION = 3;

function createMultiAgentSummary(workspace: AgentWorkspace): VercelEveMultiAgentSummary {
  return {
    agents: workspace.members.map((member) => ({
      name: member.name,
      routePrefix: `/${member.name}`,
      summaryPath: relative(
        workspace.root,
        join(member.appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH),
      ).replaceAll("\\", "/"),
    })),
    generatorVersion: resolveInstalledPackageInfo().version,
    kind: VERCEL_EVE_MULTI_AGENT_SUMMARY_KIND,
    schemaVersion: VERCEL_EVE_MULTI_AGENT_SUMMARY_VERSION,
  };
}

/** Emit the inferred Vercel Services project for a strict hostless workspace. */
export async function buildAgentWorkspace(workspace: AgentWorkspace): Promise<string> {
  const config = await readVercelJsonFile(join(workspace.root, "vercel.json"));
  if (
    config.services !== undefined ||
    config.experimentalServices !== undefined ||
    config.experimentalServicesV2 !== undefined
  ) {
    throw new Error(
      "This project defines its Vercel service graph in vercel.json. Run `vercel build` to build the complete project, or run `eve build` from an individual agent directory.",
    );
  }

  const agents = workspace.members.map((member) => ({
    agent: {
      appRoot: member.appRoot,
      buildCommand: `node ${quoteVercelShellArgument(
        toVercelRelativePath(member.appRoot, resolveEveBinaryPath(member.appRoot)),
      )} build`,
      name: member.name,
      publicRoutePrefix: `/${member.name}`,
      workspaceMember: true,
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
    assembled.rootDirectories.map((rootDirectory) => mkdir(rootDirectory, { recursive: true })),
  );
  await mkdir(join(workspace.root, ".eve"), { recursive: true });
  await writeFile(
    join(workspace.root, VERCEL_EVE_MULTI_AGENT_SUMMARY_OUTPUT_PATH),
    `${JSON.stringify(createMultiAgentSummary(workspace), null, 2)}\n`,
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
