import type { InstrumentationModelCallCompletedEvent } from "#instrumentation/lifecycle.js";
import { isNonEmptyString, isObject, isPlainRecord } from "#shared/guards.js";

type GatewayCallMetadata = NonNullable<InstrumentationModelCallCompletedEvent["gateway"]>;

export function gatewayCallMetadata(
  providerMetadata: Readonly<Record<string, unknown>> | undefined,
): GatewayCallMetadata | undefined {
  const gateway = providerMetadata?.gateway;
  if (!isPlainRecord(gateway)) return undefined;
  const metadata: {
    -readonly [Key in keyof GatewayCallMetadata]: GatewayCallMetadata[Key];
  } = {};
  if (isNonEmptyString(gateway.generationId)) {
    metadata.generationId = gateway.generationId;
  }
  if (isObject(gateway.transcripts) && gateway.transcripts.enabled === true) {
    metadata.transcriptsEnabled = true;
  }
  return Object.keys(metadata).length === 0 ? undefined : Object.freeze(metadata);
}
