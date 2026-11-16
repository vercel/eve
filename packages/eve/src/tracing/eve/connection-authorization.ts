import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import type { Attributes } from "#compiled/@vercel/agent-runs/index.js";
import { truncateTelemetryText } from "#compiled/@vercel/agent-runs/otel.js";

/**
 * A reason as a machine-readable code, such as `access_denied`. A sign-in that failed without
 * one records the error's message instead, which can carry a provider's text, so it is dropped.
 */
export function authorizationReasonCode(reason: string | undefined): string | undefined {
  return reason !== undefined && /^[A-Za-z][\w.-]{0,63}$/.test(reason) ? reason : undefined;
}

/**
 * The connection that refused a call and its reason code, with no message. A call can fail this
 * way without asking anyone to sign in, such as in a turn a schedule started.
 */
export function connectionAuthorizationAttributes(error: unknown): Attributes | undefined {
  if (!isConnectionAuthorizationFailedError(error)) return undefined;
  const { connectionName, reason } = error as { connectionName: unknown; reason?: unknown };
  return {
    "agent.connection.name":
      typeof connectionName === "string" ? truncateTelemetryText(connectionName, 256) : undefined,
    "agent.connection.authorization.reason": authorizationReasonCode(
      typeof reason === "string" ? reason : undefined,
    ),
  };
}
