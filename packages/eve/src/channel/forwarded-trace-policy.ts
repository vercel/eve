import { z } from "#compiled/zod/index.js";

import type { ForwardedTracePolicy, SessionAuthContext } from "#channel/types.js";
import type { TrustedForwarders } from "#channel/forwarded-principal.js";
import { createLogger, logError } from "#internal/logging.js";
import { CHANNEL_AUDIENCES } from "#shared/channel-audience.js";

const log = createLogger("channel.forwarded-trace-policy");

const instrumentationDecisionSchema = z.union([
  z.object({ action: z.literal("drop") }).strict(),
  z
    .object({
      action: z.literal("record"),
      recordInputs: z.boolean(),
      recordOutputs: z.boolean(),
    })
    .strict(),
]);

const forwardedTracePolicySchema = z
  .object({
    audience: z.enum(CHANNEL_AUDIENCES),
    decision: instrumentationDecisionSchema.optional(),
  })
  .strict();

export function parseForwardedTracePolicy(value: unknown): ForwardedTracePolicy | undefined {
  const parsed = forwardedTracePolicySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Accepts trace policy only through the receiver's transport-principal allowlist. */
export async function resolveForwardedTracePolicy(input: {
  readonly forwarder: SessionAuthContext;
  readonly payload: Record<string, unknown>;
  readonly trustedForwarders: TrustedForwarders | undefined;
}): Promise<ForwardedTracePolicy | undefined> {
  if (input.trustedForwarders === undefined) return undefined;
  const policy = parseForwardedTracePolicy(input.payload.forwardedTracePolicy);
  if (policy === undefined) return undefined;

  try {
    return (await input.trustedForwarders(input.forwarder)) ? policy : undefined;
  } catch (error) {
    logError(log, "trustedForwarders handler failed for trace policy", error, {
      forwarder: input.forwarder.principalId,
    });
    return undefined;
  }
}
