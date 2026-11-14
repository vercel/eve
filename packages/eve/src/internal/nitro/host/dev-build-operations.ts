import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { mapConcurrent } from "#shared/map-concurrent.js";
import { createHostNitro } from "#internal/nitro/host/create-host-nitro.js";
import { createHostSpec } from "#internal/nitro/host/host-spec.js";
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
  const inputIds: string[] = [];
  const nitro = await createHostNitro(
    createHostSpec(
      host,
      { kind: "development" },
      { buildDir: host.workspace.nitroBuildDir, outputDir: host.workspace.nitroOutputDir },
    ),
    {
      onBuildInputs: (ids) => {
        inputIds.push(...ids);
      },
    },
  );
  const payload = await buildDevelopmentHostCandidate({ host, nitro });
  return { ...payload, inputs: await statBuildInputs(inputIds) };
}

async function statBuildInputs(
  ids: readonly string[],
): Promise<Record<string, readonly [number, number]>> {
  // Asset imports such as `?raw` read the file without the query.
  const files = [
    ...new Set(ids.filter((id) => isAbsolute(id)).map((id) => id.replace(/[?#].*$/u, ""))),
  ];
  const stats = await mapConcurrent(files, async (file) => await stat(file).catch(() => undefined));
  return Object.fromEntries(
    files.flatMap((file, index) => {
      const fileStat = stats[index];
      return fileStat === undefined ? [] : [[file, [fileStat.mtimeMs, fileStat.size] as const]];
    }),
  );
}
