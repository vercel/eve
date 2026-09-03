import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentWorkspace } from "#internal/project-context.js";
import { assembleEveVercelServices } from "#internal/vercel/assemble-eve-services.js";
import { buildMultiAgentLandingPage } from "#internal/vercel/build-multi-agent-landing-page.js";
import { quoteVercelShellArgument, toVercelRelativePath } from "#internal/vercel/build-command.js";
import { readVercelJsonFile } from "#internal/vercel/vercel-services-config.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";

const VERCEL_BUILD_OUTPUT_VERSION = 3;

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
  const staticDirectory = join(outputDirectory, "static");
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(join(staticDirectory, "index.html"), buildMultiAgentLandingPage(workspace));
  await writeFile(
    join(outputDirectory, "config.json"),
    `${JSON.stringify(
      {
        version: VERCEL_BUILD_OUTPUT_VERSION,
        routes: [...assembled.routes, { handle: "filesystem" }],
        services: assembled.services,
      },
      null,
      2,
    )}\n`,
  );
  return outputDirectory;
}
