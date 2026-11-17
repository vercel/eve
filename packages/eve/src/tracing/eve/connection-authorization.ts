import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import type { Attributes } from "#compiled/@vercel/agent-runs/index.js";
import { truncateTelemetryText } from "#compiled/@vercel/agent-runs/otel.js";

export function authorizationReasonCode(reason: string | undefined): string | undefined {
  return reason !== undefined && /^[A-Za-z][\w.-]{0,63}$/.test(reason) ? reason : undefined;
}

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
