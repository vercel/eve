import {
  isEveDevEnvironment,
  resolveEveEvaluationRunId,
} from "#internal/application/dev-environment.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type { ProviderSetupContext } from "#public/instrumentation/provider.js";

/**
 * Builds the context handed to an authored `setup` at server startup.
 *
 * Shared by both layouts so the two cannot drift: a divergent context type
 * would leave `defineInstrumentation`'s union without a contextual signature
 * for `setup`, silently making every authored `setup(context)` parameter an
 * implicit `any`.
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

function resolveInstrumentationEnvironment(): ProviderSetupContext["environment"] {
  if (isEveDevEnvironment() || process.env.VERCEL_ENV === "development") return "development";
  return process.env.VERCEL_ENV === "preview" ? "preview" : "production";
}
