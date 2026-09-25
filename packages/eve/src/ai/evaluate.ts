import {
  experimental_evaluate as evaluateWithAiSdk,
  type Experimental_EvaluationModel as EvaluationModel,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai";

import { ensureAiSdkWarningLogger } from "#instrumentation/ai-sdk-warnings.js";
import { localGatewayEvaluationModel } from "#internal/model-auth/transport.js";

export const DEFAULT_EVALUATION_MODEL = "typesafe-ai/jev";

/** Evaluate typed questions about the state you pass to it using eve's model authentication. */
export function evaluate<const Questions extends Record<string, EvaluationQuestion>>({
  model = DEFAULT_EVALUATION_MODEL,
  ...options
}: Omit<Parameters<typeof evaluateWithAiSdk<Questions>>[0], "model"> & {
  /** Evaluation model instance or ID. Defaults to TypeSafe Jev. */
  model?: EvaluationModel;
}) {
  ensureAiSdkWarningLogger();
  return evaluateWithAiSdk({
    ...options,
    model:
      typeof model === "string" && Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER") == null
        ? (localGatewayEvaluationModel(model) ?? model)
        : model,
  });
}
