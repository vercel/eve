import { peekLinuxDockerDaemonAvailability } from "#execution/sandbox/bindings/docker-cli.js";
import {
  DEVELOPMENT_BUILD_MESSAGE_KIND,
  type DevelopmentBuildOutcome,
  type DevelopmentBuildRequest,
  type DevelopmentBuildResponse,
  type DevelopmentPrepareInput,
  serializeError,
} from "#internal/nitro/host/dev-build-host.js";
import {
  buildDevelopmentHost,
  prepareDevelopmentBuild,
} from "#internal/nitro/host/dev-build-operations.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

// IPC disconnect is the dev server's death signal: it fires however that process exits.
process.once("disconnect", () => process.exit(0));

process.on("message", async (request: Partial<DevelopmentBuildRequest> | null) => {
  if (request?.kind !== DEVELOPMENT_BUILD_MESSAGE_KIND || request.id === undefined) {
    return;
  }

  // Also carries an earlier build's Docker probe result, which the probe adopts.
  if (request.environment !== undefined) {
    replaceEnvironment(request.environment);
  }

  // While a build runs, only its own work keeps this process alive. A build that
  // can never settle then exits the process and fails, instead of hanging.
  process.channel?.unref();
  let outcome: DevelopmentBuildOutcome;

  try {
    outcome = {
      ok: true,
      value:
        request.operation === "buildHost"
          ? await buildDevelopmentHost(request.input as PreparedDevelopmentApplicationHost)
          : await prepareDevelopmentBuild(request.input as DevelopmentPrepareInput),
    };
  } catch (error) {
    outcome = { ok: false, error: serializeError(error) };
  }

  process.channel?.ref();
  const response: DevelopmentBuildResponse = {
    ...outcome,
    dockerAvailability: peekLinuxDockerDaemonAvailability(),
    id: request.id,
    kind: DEVELOPMENT_BUILD_MESSAGE_KIND,
  };
  process.send?.(response);
});

// Each build sees exactly the dev server's environment, and nothing an earlier build set.
function replaceEnvironment(environment: Readonly<Record<string, string | undefined>>): void {
  for (const key of Object.keys(process.env)) {
    if (environment[key] === undefined) delete process.env[key];
  }

  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value;
  }
}
