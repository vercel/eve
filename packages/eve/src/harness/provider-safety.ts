import type { SessionAuthContext } from "#channel/types.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { mergeObjects } from "#shared/objects.js";

/**
 * Adds a provider-specific end-user safety identifier without disclosing the
 * raw eve principal. Authored provider options take precedence over the default.
 */
export function mergeProviderSafetyIdentifier(
  modelReference: RuntimeModelReference,
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  auth: SessionAuthContext | null,
): Record<string, unknown> | undefined {
  if (auth === null) {
    return providerOptions;
  }

  const ownerKey = invocationOwnerKey(auth);
  const provider = modelReference.id.split("/", 1)[0]?.toLowerCase();
  const defaults =
    provider === "openai"
      ? { openai: { safetyIdentifier: ownerKey } }
      : provider === "anthropic"
        ? { anthropic: { metadata: { userId: ownerKey } } }
        : undefined;

  return defaults === undefined ? providerOptions : mergeObjects(defaults, providerOptions);
}
