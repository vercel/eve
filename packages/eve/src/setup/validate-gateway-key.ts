import { createGateway } from "ai";

import { vercelGatewayFetch } from "#internal/gateway.js";
import { toErrorMessage } from "#shared/errors.js";

function isGatewayAuthRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { type?: unknown; name?: unknown; statusCode?: unknown };
  return (
    candidate.type === "authentication_error" ||
    candidate.name === "GatewayAuthenticationError" ||
    candidate.statusCode === 401
  );
}

const VALIDATION_TIMEOUT_MS = 10_000;

export type GatewayKeyValidation =
  | { kind: "valid" }
  | { kind: "invalid"; message: string }
  | { kind: "inconclusive"; message: string };

export async function validateGatewayApiKey(
  apiKey: string,
  signal?: AbortSignal,
): Promise<GatewayKeyValidation> {
  const timeout = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
  const effectiveSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const provider = createGateway({
      apiKey,
      fetch: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        vercelGatewayFetch(url, { ...init, signal: effectiveSignal }),
    });
    await provider.getCredits();
    return { kind: "valid" };
  } catch (error) {
    if (signal?.aborted === true) throw error;
    if (isGatewayAuthRejection(error)) {
      return { kind: "invalid", message: "The AI Gateway rejected this key." };
    }
    return { kind: "inconclusive", message: toErrorMessage(error) };
  }
}
