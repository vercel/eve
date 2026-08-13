import { join } from "node:path";

import type { AgentWorkspace } from "#internal/agent-workspace.js";
import { readVercelJsonFile } from "#internal/vercel/vercel-services-config.js";

export type AgentWorkspaceDeploymentMode = "authored" | "inferred";

/** Resolve and validate the Vercel deployment policy for an agent workspace. */
export async function resolveAgentWorkspaceDeploymentMode(
  workspace: AgentWorkspace,
): Promise<AgentWorkspaceDeploymentMode> {
  const config = await readVercelJsonFile(join(workspace.root, "vercel.json"));
  return config.services !== undefined ||
    config.experimentalServices !== undefined ||
    config.experimentalServicesV2 !== undefined
    ? "authored"
    : "inferred";
}
