import { compileAgent } from "#compiler/compile-agent.js";
import { DiscoveryProjectResolutionError } from "#discover/project.js";
import { createEveChannelRouteMounts, type EveChannelRouteMount } from "./channel-route-mounts.js";

export async function resolveEveChannelRouteMounts(input: {
  readonly appRoot: string;
  readonly publicRoutePrefix: string;
}): Promise<readonly EveChannelRouteMount[]> {
  try {
    const result = await compileAgent({ startPath: input.appRoot });
    return createEveChannelRouteMounts({
      channels: result.manifest.channels,
      publicRoutePrefix: input.publicRoutePrefix,
    });
  } catch (error) {
    // Preserve withEve's existing config-time behavior for projects whose
    // agent files are created later in the build. The eve build still reports
    // a missing agent with its normal discovery diagnostic.
    if (error instanceof DiscoveryProjectResolutionError) return [];
    throw error;
  }
}
