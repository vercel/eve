import { createHostNitro } from "#internal/nitro/host/create-host-nitro.js";
import { createHostSpec } from "#internal/nitro/host/host-spec.js";
import type {
  DevelopmentHostBuild,
  DevelopmentPrepareInput,
} from "#internal/nitro/host/dev-build-host.js";
import { buildDevelopmentHostCandidate } from "#internal/nitro/host/dev-host-candidate.js";
import { prepareDevelopmentApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import { platformBuildOutput } from "#platform/build-output.js";

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

export async function buildDevelopmentHost(
  host: PreparedDevelopmentApplicationHost,
): Promise<DevelopmentHostBuild> {
  const nitro = await createHostNitro(
    createHostSpec(
      host,
      { kind: "development" },
      { buildDir: host.workspace.nitroBuildDir, outputDir: host.workspace.nitroOutputDir },
      platformBuildOutput(),
    ),
  );
  return await buildDevelopmentHostCandidate({ host, nitro });
}
