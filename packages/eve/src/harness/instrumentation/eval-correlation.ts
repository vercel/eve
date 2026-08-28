import { contextStorage } from "#context/container.js";
import { EvalExecutionIdentityKey } from "#context/keys.js";
import type { ContextReader } from "#context/key.js";

const EVAL_ID_ATTRIBUTE = "eve.eval.id";
const EVAL_RUN_ID_ATTRIBUTE = "eve.eval.run_id";
const SESSION_ID_ATTRIBUTE = "eve.session.id";

/** Framework-owned correlation values for one eval-backed runtime session. */
export function buildEvalCorrelationContext(
  sessionId: string,
  context: ContextReader | undefined = contextStorage.getStore(),
): Readonly<Record<string, string>> {
  const identity = context?.get(EvalExecutionIdentityKey);
  return {
    ...(identity === undefined
      ? {}
      : {
          [EVAL_ID_ATTRIBUTE]: identity.evalId,
          [EVAL_RUN_ID_ATTRIBUTE]: identity.runId,
        }),
    [SESSION_ID_ATTRIBUTE]: sessionId,
  };
}

/** Selects raw framework correlation attributes from merged runtime context. */
export function evalCorrelationSpanAttributes(
  runtimeContext: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string>> {
  if (runtimeContext === undefined) return {};

  const attributes: Record<string, string> = {};
  for (const key of [EVAL_ID_ATTRIBUTE, EVAL_RUN_ID_ATTRIBUTE, SESSION_ID_ATTRIBUTE]) {
    const value = runtimeContext[key];
    if (typeof value === "string" && value.length > 0) attributes[key] = value;
  }
  return attributes;
}
