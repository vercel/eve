import type { DeliverHookPayload } from "#channel/types.js";

/** Exact trusted deployment shared by every payload in a delivery. */
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
