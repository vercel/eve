import {
  resolveInstrumentationEnvironment,
  resolveEveEvaluationRunId,
} from "#internal/application/dev-environment.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type { ProviderSetupContext } from "#public/instrumentation/provider.js";

/**
 * Builds the context handed to an authored `setup` at server startup.
 *
 * @internal — not part of the public API.
 */
export function createInstrumentationSetupContext(agentName: string): ProviderSetupContext {
  const evaluationRunId = resolveEveEvaluationRunId();
  return {
    agentName,
    environment: resolveInstrumentationEnvironment(),
    evaluation: evaluationRunId === undefined ? undefined : { runId: evaluationRunId },
    frameworkVersion: resolveInstalledPackageInfo().version,
  };
}
