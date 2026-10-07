import {
  experimental_decide as decideWithAiSdk,
  type Experimental_DecisionModel as DecisionModel,
  type Experimental_DecisionQuestion as DecisionQuestion,
} from "ai";

import { ensureAiSdkWarningLogger } from "#instrumentation/ai-sdk-warnings.js";
import { localGatewayDecisionModel } from "#internal/model-auth/transport.js";

export const DEFAULT_DECISION_MODEL = "typesafe-ai/jev";

/** Decide typed questions about the state you pass to it using eve's model authentication. */
export function decide<const Questions extends Record<string, DecisionQuestion>>({
  model = DEFAULT_DECISION_MODEL,
  ...options
}: Omit<Parameters<typeof decideWithAiSdk<Questions>>[0], "model"> & {
  /** Decision model instance or ID. Defaults to TypeSafe Jev. */
  model?: DecisionModel;
}) {
  ensureAiSdkWarningLogger();
  return decideWithAiSdk({
    ...options,
    model:
      typeof model === "string" && Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER") == null
        ? (localGatewayDecisionModel(model) ?? model)
        : model,
  });
}
