import type { SessionAuthContext } from "#channel/types.js";
import type { ContextReader } from "#context/key.js";
import { AuthKey, InitiatorAuthKey } from "#context/keys.js";
import type {
  InstrumentationPrincipalSummary,
  InstrumentationPrincipalType,
} from "#instrumentation/lifecycle.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import { shouldCaptureInstrumentationContent } from "#shared/instrumentation-content.js";

const PRINCIPAL_TYPES = new Set<InstrumentationPrincipalType>([
  "anonymous",
  "app",
  "local-dev",
  "runtime",
  "service",
  "user",
]);

export function summarizeInstrumentationPrincipal(
  principal: SessionAuthContext | null | undefined,
  audience: ChannelAudience,
): InstrumentationPrincipalSummary | undefined {
  if (principal === undefined) return undefined;
  if (principal === null) return { type: "none" };
  const type = PRINCIPAL_TYPES.has(principal.principalType as InstrumentationPrincipalType)
    ? (principal.principalType as InstrumentationPrincipalType)
    : "other";
  if (!shouldCaptureInstrumentationContent(audience)) return { type };
  return { id: principal.principalId, type };
}

export function readInstrumentationPrincipals(
  context: ContextReader,
  audience: ChannelAudience,
): {
  readonly currentPrincipal?: InstrumentationPrincipalSummary;
  readonly initiatorPrincipal?: InstrumentationPrincipalSummary;
} {
  return {
    currentPrincipal: summarizeInstrumentationPrincipal(context.get(AuthKey), audience),
    initiatorPrincipal: summarizeInstrumentationPrincipal(context.get(InitiatorAuthKey), audience),
  };
}
