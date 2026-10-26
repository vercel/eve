import { experimental_decide as decideWithAiSdk } from "ai";
import type { DecisionOptions, DecisionQuestion } from "#ai/decision-types.js";
import { ensureAiSdkWarningLogger } from "#instrumentation/ai-sdk-warnings.js";
import { localGatewayDecisionModel } from "#internal/model-auth/transport.js";

export const DEFAULT_DECISION_MODEL = "typesafe-ai/jev";

/** Internal eval diagnostics retain SDK metadata without promising it to applications. */
export function decideWithMetadata<
  const Questions extends Readonly<Record<string, DecisionQuestion>>,
>({
  model = DEFAULT_DECISION_MODEL,
  state,
  questions,
  maxRetries,
  signal,
  providerOptions,
}: DecisionOptions<Questions> & {
  readonly providerOptions?: Parameters<typeof decideWithAiSdk>[0]["providerOptions"];
}) {
  ensureAiSdkWarningLogger();
  if (
    typeof model !== "string" &&
    typeof Reflect.get(model, "doDecide") !== "function" &&
    typeof Reflect.get(model, "doEvaluate") !== "function"
  ) {
    throw new TypeError(
      "decide requires a provider decision model implementation, not just its identity.",
    );
  }
  return decideWithAiSdk({
    model: (typeof model === "string" && Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER") == null
      ? (localGatewayDecisionModel(model) ?? model)
      : model) as Parameters<typeof decideWithAiSdk>[0]["model"],
    state,
    questions,
    maxRetries,
    abortSignal: signal,
    providerOptions,
  });
}
