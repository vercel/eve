import {
  resolveInstrumentationEnvironment,
  resolveEveEvaluationRunId,
} from "#internal/application/dev-environment.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type { Entities } from "#platform/entities.js";
import type { InstrumentationSetupContext } from "#public/instrumentation/provider.js";

/** @internal */
export function createInstrumentationSetupContext(
  agentName: string,
  platform: Entities,
): InstrumentationSetupContext {
  const evaluationRunId = resolveEveEvaluationRunId();
  return {
    agentName,
    environment: resolveInstrumentationEnvironment(platform),
    evaluation: evaluationRunId === undefined ? undefined : { runId: evaluationRunId },
    frameworkVersion: resolveInstalledPackageInfo().version,
  };
}
