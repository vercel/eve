import * as aiSdk from "ai";
import type { DecisionOptions, DecisionQuestion } from "#ai/decision-types.js";
import { ensureAiSdkWarningLogger } from "#instrumentation/ai-sdk-warnings.js";
import { localGatewayDecisionModel } from "#internal/model-auth/transport.js";

export const DEFAULT_DECISION_MODEL = "typesafe-ai/jev";

type AiSdkDecide = typeof aiSdk.experimental_decide;

/**
 * `ai` is a peer dependency and its decision API is experimental, so a newer release may
 * graduate it to `decide` or drop it. Reading it from the namespace keeps that a clear runtime
 * error at the call site instead of a missing-export failure when `eve/ai` is imported.
 */
function resolveAiSdkDecide(): AiSdkDecide {
  const decideWithAiSdk = Reflect.get(aiSdk, "decide") ?? Reflect.get(aiSdk, "experimental_decide");
  if (typeof decideWithAiSdk !== "function") {
    throw new Error(
      'decide requires an installed "ai" package that exports decide or experimental_decide. Install a version of "ai" supported by eve, such as ai@^7.0.137.',
    );
  }
  return decideWithAiSdk as AiSdkDecide;
}

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
  readonly providerOptions?: Parameters<AiSdkDecide>[0]["providerOptions"];
}) {
  const decideWithAiSdk = resolveAiSdkDecide();
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
      : model) as Parameters<AiSdkDecide>[0]["model"],
    state,
    questions,
    maxRetries,
    abortSignal: signal,
    providerOptions,
  });
}
