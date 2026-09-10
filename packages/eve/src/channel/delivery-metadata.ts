import type {
  ChannelDeliveryMetadata,
  SessionAuthContext,
  SessionTraceContext,
} from "#channel/types.js";

export interface ChannelDeliverySource {
  readonly acceptedDeploymentId?: string;
  readonly channelKind: string;
  readonly channelName: string;
  readonly requestId?: string;
  readonly requestTraceContext?: SessionTraceContext;
}

/** Mints the opaque identity for one inbound channel operation. */
export function createChannelDeliveryMetadata(
  source: ChannelDeliverySource,
): ChannelDeliveryMetadata {
  const metadata: {
    acceptedDeploymentId?: string;
    channelKind: string;
    channelName: string;
    deliveryId: string;
    requestId?: string;
    requestTraceContext?: SessionTraceContext;
  } = {
    channelKind: source.channelKind,
    channelName: source.channelName,
    deliveryId: crypto.randomUUID(),
  };
  if (source.acceptedDeploymentId !== undefined) {
    metadata.acceptedDeploymentId = source.acceptedDeploymentId;
  }
  if (source.requestId !== undefined) metadata.requestId = source.requestId;
  if (source.requestTraceContext !== undefined) {
    metadata.requestTraceContext = source.requestTraceContext;
  }
  return metadata;
}

/** Binds a caller-owned operation to one immutable session and authenticated principal. */
export async function createSessionOperationDelivery(input: {
  readonly auth: SessionAuthContext | null;
  readonly operationId: string;
  readonly sessionId: string;
  readonly source?: Partial<ChannelDeliverySource>;
}): Promise<ChannelDeliveryMetadata> {
  const deliveryId = await getSessionOperationDeliveryId(input);
  return {
    ...createChannelDeliveryMetadata({
      ...input.source,
      channelKind: input.source?.channelKind ?? "session",
      channelName: input.source?.channelName ?? "session",
    }),
    deliveryId,
  };
}

/** Computes correlation before sending, including when an accepted send response is lost.
 * Persist this with the exact session ID; never reuse the operation in a replacement session. */
export async function getSessionOperationDeliveryId(input: {
  readonly auth: SessionAuthContext | null;
  readonly operationId: string;
  readonly sessionId: string;
}): Promise<string> {
  if (input.auth === null || input.auth.principalType === "anonymous") {
    throw new Error("operationId requires an authenticated principal.");
  }
  if (input.operationId.length === 0 || input.operationId.length > 512) {
    throw new Error("operationId must contain between 1 and 512 characters.");
  }
  const identity = JSON.stringify([
    "eve:session-send:v1",
    input.sessionId,
    input.auth.authenticator,
    input.auth.issuer ?? null,
    input.auth.principalType,
    input.auth.principalId,
    input.operationId,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `operation:${hex}`;
}
