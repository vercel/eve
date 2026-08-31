import { readFile } from "node:fs/promises";

import type { AgentWorkspace, AgentWorkspaceMember } from "#internal/agent-workspace.js";
import type { ApplicationBuildOptions } from "#internal/nitro/host/types.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { spawnPackageManager } from "#setup/primitives/pm/run.js";
import { parseJsonObject } from "#shared/json.js";

export type AgentWorkspaceBuildApplication = (
  appRoot: string,
  options: ApplicationBuildOptions,
) => Promise<string>;

async function hasBuildScript(member: AgentWorkspaceMember): Promise<boolean> {
  if (member.packageJsonPath === undefined) return false;

  const packageJson = parseJsonObject(JSON.parse(await readFile(member.packageJsonPath, "utf8")));
  if (packageJson.scripts === undefined) return false;
  const scripts = parseJsonObject(packageJson.scripts);
  return typeof scripts.build === "string";
}

/** Builds every agent in a workspace for a host that runs members independently. */
export async function buildAgentWorkspaceMembers(
  workspace: AgentWorkspace,
  buildApplication: AgentWorkspaceBuildApplication,
): Promise<
  readonly { readonly appRoot: string; readonly name: string; readonly outputDir?: string }[]
> {
  const packageManager = await detectPackageManager(workspace.root);
  const results: { appRoot: string; name: string; outputDir?: string }[] = [];

  for (const member of workspace.members) {
    if (await hasBuildScript(member)) {
      const built = await spawnPackageManager(packageManager.kind, member.appRoot, [
        "run",
        "build",
      ]);
      if (!built) {
        throw new Error(`Failed to build workspace agent "${member.name}" at ${member.appRoot}.`);
      }
      results.push({ appRoot: member.appRoot, name: member.name });
      continue;
    }

    results.push({
      appRoot: member.appRoot,
      name: member.name,
      outputDir: await buildApplication(member.appRoot, {
        publicRoutePrefix: undefined,
        skipVercelSandboxPrewarm: false,
        vercelServiceOutput: undefined,
      }),
    });
  }

  return results;
}
