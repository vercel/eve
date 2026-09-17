import type { SessionAuthContext } from "#channel/types.js";
import type { ContextReader } from "#context/key.js";
import { AuthKey, InitiatorAuthKey } from "#context/keys.js";
import {
  isInstrumentationPrincipalType,
  type InstrumentationPrincipalSummary,
} from "#instrumentation/lifecycle.js";
import {
  shouldCaptureInstrumentationContent,
  type InstrumentationContentContext,
} from "#shared/instrumentation-content.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import { resolveTracePolicyDecision } from "#shared/trace-policy.js";
import { boundedPrincipalId } from "#tracing/telemetry-budget.js";

export function summarizeInstrumentationPrincipal(
  principal: SessionAuthContext | null | undefined,
  content: InstrumentationContentContext,
): InstrumentationPrincipalSummary | undefined {
  if (principal === undefined) return undefined;
  if (principal === null) return { type: "none" };
  const type =
    isInstrumentationPrincipalType(principal.principalType) && principal.principalType !== "none"
      ? principal.principalType
      : "other";
  const id = shouldCaptureInstrumentationContent(content)
    ? boundedPrincipalId(principal.principalId)
    : undefined;
  return id === undefined ? { type } : { id, type };
}

export function applyPrincipalTraceDecision(
  principal: InstrumentationPrincipalSummary | undefined,
  decision: InstrumentationDecision | undefined,
): InstrumentationPrincipalSummary | undefined {
  if (principal === undefined) return undefined;
  return principal.type !== "none" &&
    decision?.action === "record" &&
    decision.recordInputs &&
    decision.recordOutputs
    ? principal
    : { type: principal.type };
}

export function readInstrumentationPrincipals(
  context: ContextReader,
  content: InstrumentationContentContext,
  decision: InstrumentationDecision = resolveTracePolicyDecision(true, content),
): {
  readonly currentPrincipal?: InstrumentationPrincipalSummary;
  readonly initiatorPrincipal?: InstrumentationPrincipalSummary;
} {
  return {
    currentPrincipal: applyPrincipalTraceDecision(
      summarizeInstrumentationPrincipal(context.get(AuthKey), content),
      decision,
    ),
    initiatorPrincipal: applyPrincipalTraceDecision(
      summarizeInstrumentationPrincipal(context.get(InitiatorAuthKey), content),
      decision,
    ),
  };
}
