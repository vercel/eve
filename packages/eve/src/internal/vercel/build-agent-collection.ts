import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentCollection, AgentCollectionMember } from "#internal/agent-collection.js";
import { assembleEveVercelServices } from "#internal/vercel/assemble-eve-services.js";
import { quoteVercelShellArgument, toVercelRelativePath } from "#internal/vercel/build-command.js";
import { resolveAgentCollectionDeploymentMode } from "#internal/vercel/agent-collection-deployment.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { parseJsonObject } from "#shared/json.js";

const VERCEL_BUILD_OUTPUT_VERSION = 3;

async function hasBuildScript(member: AgentCollectionMember): Promise<boolean> {
  if (member.packageJsonPath === undefined) return false;
  const packageJson = parseJsonObject(JSON.parse(await readFile(member.packageJsonPath, "utf8")));
  if (packageJson.scripts === undefined) return false;
  const scripts = parseJsonObject(packageJson.scripts);
  return typeof scripts.build === "string";
}

async function resolveMemberBuildCommand(
  member: AgentCollectionMember,
  packageManager: PackageManagerKind,
): Promise<string> {
  if (await hasBuildScript(member)) return `${packageManager} run build`;

  return `node ${quoteVercelShellArgument(
    toVercelRelativePath(member.appRoot, resolveEveBinaryPath(member.appRoot)),
  )} build`;
}

/** Emit the inferred Vercel Services project for a strict hostless collection. */
export async function buildAgentCollection(collection: AgentCollection): Promise<string> {
  if ((await resolveAgentCollectionDeploymentMode(collection)) === "authored") {
    throw new Error(
      "This project defines its Vercel service graph in vercel.json. Run `vercel build` to build the complete project, or run `eve build` from an individual agent directory.",
    );
  }

  const packageManager = await detectPackageManager(collection.root);
  const agents = await Promise.all(
    collection.members.map(async (member) => ({
      agent: {
        appRoot: member.appRoot,
        buildCommand: await resolveMemberBuildCommand(member, packageManager.kind),
        name: member.name,
        publicRoutePrefix: `/eve/agents/${member.name}`,
      },
      target: {
        hostOutputDirectory: join(collection.root, ".vercel", "output"),
        projectRoot: collection.root,
      },
    })),
  );
  const assembled = assembleEveVercelServices({ agents });

  const outputDirectory = join(collection.root, ".vercel", "output");
  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });
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
