import { resolve } from "node:path";

import { buildApplicationFromResolvedRoot } from "#internal/nitro/host/build-application.js";
import { compileEmbeddedAgent } from "./compile.js";

export interface BuildEmbeddedApplicationInput {
  readonly appRoot: string;
  readonly entrypoint: string;
  readonly skipVercelSandboxPrewarm?: boolean;
}

export interface BuildEmbeddedApplicationResult {
  readonly outputDirectory: string;
}

export async function buildEmbeddedApplication(
  input: BuildEmbeddedApplicationInput,
): Promise<BuildEmbeddedApplicationResult> {
  const appRoot = resolve(input.appRoot);
  const outputDirectory = await buildApplicationFromResolvedRoot(
    appRoot,
    {
      skipVercelSandboxPrewarm: input.skipVercelSandboxPrewarm ?? false,
    },
    ({ artifactLocations }) =>
      compileEmbeddedAgent({
        appRoot,
        artifactLocations,
        entrypoint: input.entrypoint,
      }),
  );

  return { outputDirectory };
}
