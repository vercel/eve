import { join } from "node:path";

import { findEveProjectContext } from "#internal/project-context.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

export interface ResolvedFrameworkAgent {
  readonly appRoot: string;
  readonly name?: string;
  readonly publicRoutePrefix: string;
  readonly transportRoutePrefix: string;
  readonly workspaceMember: boolean;
}

/** Resolve one eve project root into the agents exposed by a frontend framework. */
export async function resolveFrameworkAgents(
  eveRoot: string,
): Promise<readonly ResolvedFrameworkAgent[]> {
  const context = await findEveProjectContext(eveRoot);
  if (context?.kind === "workspace" && context.workspace.root === eveRoot) {
    return context.workspace.members.map((member) => {
      const publicRoutePrefix = `/eve/${member.name}`;
      return {
        appRoot: member.appRoot,
        name: member.name,
        publicRoutePrefix,
        transportRoutePrefix: `${publicRoutePrefix}/v1`,
        workspaceMember: true,
      };
    });
  }

  return [
    {
      appRoot: eveRoot,
      publicRoutePrefix: "",
      transportRoutePrefix: EVE_ROUTE_PREFIX,
      workspaceMember: false,
    },
  ];
}

export function assertFrameworkAgentsPresent(
  agents: readonly ResolvedFrameworkAgent[],
  eveRoot: string,
): void {
  if (agents.length === 0) {
    throw new Error(
      `Found no eve workspace agents under ${join(eveRoot, "agents")}. Add an agent before starting the frontend.`,
    );
  }
}
