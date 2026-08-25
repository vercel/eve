import type { SessionAuthContext } from "#channel/types.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";

/**
 * Adds OpenAI's end-user safety identifier without disclosing the raw eve
 * principal. An authored value takes precedence over the framework default.
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
  if (openaiOptions !== undefined && Object.hasOwn(openaiOptions, "safetyIdentifier")) {
    return providerOptions;
  }

  return {
    ...providerOptions,
    openai: {
      ...openaiOptions,
      safetyIdentifier: invocationOwnerKey(auth),
    },
  };
}
