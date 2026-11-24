import {
  DEFAULT_DECISION_MODEL,
  decideWithMetadata,
  resolveDecisionModel,
} from "#ai/decision-adapter.js";
import type { DecisionPurpose } from "#ai/decide.js";
import type { DecisionOptions, DecisionQuestion } from "#ai/decision-types.js";
import { decisionResults } from "#instrumentation/decision-results.js";
import { Experimental_DecisionRefusalError as DecisionRefusalError } from "#compiled/@ai-sdk/provider/index.js";
import {
  aiSdkCapture,
  getRegisteredTelemetryIntegrations,
} from "#instrumentation/ai-sdk-telemetry.js";
import { runTracedModelCall, startModelCallTrace } from "#instrumentation/model-call-trace.js";

export async function decideWithTracing<
  const Questions extends Readonly<Record<string, DecisionQuestion>>,
>(options: DecisionOptions<Questions>, purpose: DecisionPurpose) {
  const traced = await startModelCallTrace(
    "decision",
    () => resolveDecisionModel(options.model ?? DEFAULT_DECISION_MODEL),
    purpose,
  );
  if (traced === undefined) return decideWithMetadata(options);
  if (traced.operation === undefined) {
    return decideWithMetadata(options, { telemetry: aiSdkCapture(traced.content, traced.hooks) });
  }
  const telemetry = {
    integrations: [...getRegisteredTelemetryIntegrations({ excludeEveOtelIntegration: true })],
    ...aiSdkCapture(traced.operation.capture, traced.hooks),
  };
  return runTracedModelCall(
    "decision",
    traced.operation,
    () => decideWithMetadata({ ...options, model: traced.model }, { telemetry }),
    {
      completed: (result) => decisionResults(options.questions, { answers: result.answers }),
      refused: (error) =>
        DecisionRefusalError.isInstance(error)
          ? decisionResults(options.questions, { refused: error.questionIds })
          : undefined,
    },
  );
}
