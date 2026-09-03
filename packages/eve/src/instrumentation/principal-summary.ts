import { createHash } from "node:crypto";

import type { SessionAuthContext } from "#channel/types.js";
import type {
  InstrumentationPrincipalSummary,
  InstrumentationPrincipalType,
} from "#instrumentation/lifecycle.js";

const PRINCIPAL_TYPES = new Set<InstrumentationPrincipalType>([
  "anonymous",
  "app",
  "local-dev",
  "service",
  "user",
]);

/** Produces bounded, pseudonymous span attributes without retaining principal IDs. */
export function summarizeInstrumentationPrincipal(
  principal: SessionAuthContext | null | undefined,
): InstrumentationPrincipalSummary | undefined {
  if (principal === undefined) return undefined;
  if (principal === null) return { type: "none" };
  const type = PRINCIPAL_TYPES.has(principal.principalType as InstrumentationPrincipalType)
    ? (principal.principalType as InstrumentationPrincipalType)
    : "other";
  const identity = JSON.stringify([
    "eve:instrumentation-principal:v1",
    principal.authenticator,
    principal.issuer ?? null,
    principal.principalType,
    principal.principalId,
    principal.subject ?? null,
  ]);
  return {
    fingerprint: createHash("sha256").update(identity).digest("hex").slice(0, 32),
    type,
  };
}
