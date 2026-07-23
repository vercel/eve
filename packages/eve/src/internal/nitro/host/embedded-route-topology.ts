import type { Nitro } from "nitro/types";

import {
  describeChannelNitroRouteResources,
  replaceLiveChannelVirtualHandlers,
  type NitroChannelRouteRegistration,
} from "#internal/nitro/host/channel-routes.js";
import { validateEmbeddedEveNitroRouteReplacement } from "#internal/nitro/host/embedded-nitro-host-validation.js";
import type { DevelopmentNitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";

export interface EmbeddedRouteTopologyReplacement {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Stages one validated live channel topology and restores it if Nitro cannot sync it. */
export function stageEmbeddedRouteTopology(input: {
  readonly artifactsConfig: DevelopmentNitroArtifactsConfig;
  readonly next: readonly NitroChannelRouteRegistration[];
  readonly nitro: Nitro;
  readonly previous: readonly NitroChannelRouteRegistration[];
  readonly reload: () => Promise<void>;
}): EmbeddedRouteTopologyReplacement {
  validateEmbeddedEveNitroRouteReplacement(input.nitro, {
    next: describeChannelNitroRouteResources(input.next),
    previous: describeChannelNitroRouteResources(input.previous),
  });

  try {
    applyRouteTopology(input, input.next, input.previous);
  } catch (error) {
    try {
      applyRouteTopology(input, input.previous, input.next);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Embedded channel topology staging rollback failed.",
        { cause: error },
      );
    }
    throw error;
  }

  return {
    commit: input.reload,
    async rollback() {
      applyRouteTopology(input, input.previous, input.next);
      await input.reload();
    },
  };
}

function applyRouteTopology(
  input: Pick<Parameters<typeof stageEmbeddedRouteTopology>[0], "artifactsConfig" | "nitro">,
  next: readonly NitroChannelRouteRegistration[],
  previous: readonly NitroChannelRouteRegistration[],
): void {
  replaceLiveChannelVirtualHandlers(input.nitro, {
    artifactsConfig: input.artifactsConfig,
    next,
    previous,
  });
  input.nitro.routing.sync();
}
