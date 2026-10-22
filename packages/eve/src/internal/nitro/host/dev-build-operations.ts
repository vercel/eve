import { createDevelopmentApplicationNitro } from "#internal/nitro/host/create-application-nitro.js";
import type {
  DevelopmentHostBuild,
  DevelopmentPrepareInput,
} from "#internal/nitro/host/dev-build-host.js";
import { buildDevelopmentHostCandidate } from "#internal/nitro/host/dev-host-candidate.js";
import { prepareDevelopmentApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

/** Compiles the agent and stages a candidate generation in its own host workspace. */
export async function prepareDevelopmentBuild(
  input: DevelopmentPrepareInput,
): Promise<PreparedDevelopmentApplicationHost> {
  return await prepareDevelopmentApplicationHost(input.appRoot, {
    changedPaths: input.changedPaths,
    developmentExtensions: input.developmentExtensions,
    previousExtensions: input.previousExtensions,
    workspace: input.workspace,
  });
}

/** Builds the Nitro host for a prepared candidate and returns its worker entry. */
export async function buildDevelopmentHost(
  host: PreparedDevelopmentApplicationHost,
): Promise<DevelopmentHostBuild> {
  const nitro = await createDevelopmentApplicationNitro(host);
  return await buildDevelopmentHostCandidate({ host, nitro });
}
