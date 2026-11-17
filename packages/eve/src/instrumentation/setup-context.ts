import {
  resolveInstrumentationEnvironment,
  resolveEveEvaluationRunId,
} from "#internal/application/dev-environment.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type { InstrumentationSetupContext } from "#public/instrumentation/provider.js";

/** @internal */
export function createInstrumentationSetupContext(agentName: string): InstrumentationSetupContext {
  const evaluationRunId = resolveEveEvaluationRunId();
  return {
    agentName,
    environment: resolveInstrumentationEnvironment(),
    evaluation: evaluationRunId === undefined ? undefined : { runId: evaluationRunId },
    frameworkVersion: resolveInstalledPackageInfo().version,
  };
}
