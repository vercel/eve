import type { SessionAuthContext } from "#channel/types.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";

/**
 * Adds OpenAI's end-user safety identifier without disclosing the raw eve
 * principal. The framework-owned value replaces an authored value so every
 * request follows the active turn's caller.
 */
export function mergeOpenAISafetyIdentifier(
  modelReference: RuntimeModelReference,
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  auth: SessionAuthContext | null,
): Record<string, unknown> | undefined {
  if (auth === null || modelReference.id.split("/", 1)[0]?.toLowerCase() !== "openai") {
    return providerOptions;
  }

  const openai = providerOptions?.openai;
  const openaiOptions =
    openai !== null && typeof openai === "object" && !Array.isArray(openai) ? openai : undefined;

  return {
    ...providerOptions,
    openai: {
      ...openaiOptions,
      safetyIdentifier: invocationOwnerKey(auth),
    },
  };
}
