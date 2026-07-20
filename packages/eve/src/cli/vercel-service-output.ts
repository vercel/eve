import { resolve } from "node:path";

import {
  EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV,
  EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV,
} from "#internal/application/paths.js";
import type { ApplicationBuildOptions } from "#internal/nitro/host/types.js";

type VercelServiceOutput = NonNullable<ApplicationBuildOptions["vercelServiceOutput"]>;

function resolveInternalBuildDirectory(
  appRoot: string,
  environmentVariableName: string,
): string | undefined {
  const configuredDirectory = process.env[environmentVariableName];

  if (configuredDirectory === undefined || configuredDirectory.trim().length === 0) {
    return undefined;
  }

  return resolve(appRoot, configuredDirectory);
}

export function resolveInternalVercelServiceOutput(
  appRoot: string,
): VercelServiceOutput | undefined {
  const hostOutputDirectory = resolveInternalBuildDirectory(
    appRoot,
    EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV,
  );
  const serviceOutputDirectory = resolveInternalBuildDirectory(
    appRoot,
    EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV,
  );

  if (hostOutputDirectory === undefined && serviceOutputDirectory === undefined) {
    return undefined;
  }
  if (hostOutputDirectory === undefined || serviceOutputDirectory === undefined) {
    throw new Error(
      `${EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV} and ${EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV} must be set together.`,
    );
  }

  return { hostOutputDirectory, serviceOutputDirectory };
}
