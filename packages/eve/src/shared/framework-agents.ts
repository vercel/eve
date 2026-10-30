import { join, resolve } from "node:path";

import { findEveProjectContext } from "#internal/project-context.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { createNamedAgentRoutePrefix, joinEveRoutePath } from "#shared/eve-route-path.js";

export interface ResolvedFrameworkAgent {
  readonly appRoot: string;
  readonly name?: string;
  readonly publicRoutePrefix: string;
  readonly transportRoutePrefix: string;
}

/** Resolve an eve project into mounted framework agents, rejecting empty workspaces. */
export async function resolveFrameworkAgents(
  eveRoot: string,
): Promise<readonly ResolvedFrameworkAgent[]> {
  const root = resolve(eveRoot);
  const context = await findEveProjectContext(root);
  if (context?.kind === "workspace" && context.workspace.root === root) {
    if (context.workspace.members.length === 0) {
      throw new Error(
        `Found no eve workspace agents under ${join(root, "agents")}. Add an agent before starting the frontend.`,
      );
    }
    return context.workspace.members.map((member) => {
      const publicRoutePrefix = createNamedAgentRoutePrefix(member.name);
      return {
        appRoot: member.appRoot,
        name: member.name,
        publicRoutePrefix,
        transportRoutePrefix: joinEveRoutePath(publicRoutePrefix, EVE_ROUTE_PREFIX),
      };
    });
  }

  return [{ appRoot: root, publicRoutePrefix: "", transportRoutePrefix: EVE_ROUTE_PREFIX }];
}
