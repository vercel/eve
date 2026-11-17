import type { DeliverHookPayload } from "#channel/types.js";

export function readAcceptedDeploymentId(delivery: DeliverHookPayload): string | undefined {
  const acceptedDeploymentId = delivery.deliveryMetadata?.[0]?.acceptedDeploymentId;
  if (
    acceptedDeploymentId === undefined ||
    acceptedDeploymentId.length === 0 ||
    acceptedDeploymentId === "latest"
  ) {
    return undefined;
  }
  return delivery.deliveryMetadata?.every(
    (metadata) => metadata.acceptedDeploymentId === acceptedDeploymentId,
  )
    ? acceptedDeploymentId
    : undefined;
}
