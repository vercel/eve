import { ComputeError } from "#compute/errors.js";
import { parseDeploymentManifest, type ComputeDeploymentManifest } from "#compute/manifest.js";
import type { ComputeQueryExecutor } from "#compute/storage/types.js";

export interface LockedNamespace {
  admissionMode: "open" | "staging" | "frozen";
  deploymentEpoch: bigint;
  desiredDeployment: string | null;
  namespaceId: string;
  quotaBytes: bigint;
}

export async function lockNamespace(
  transaction: ComputeQueryExecutor,
  namespaceId: string,
): Promise<LockedNamespace> {
  const result = await transaction.query<{
    admission_mode: LockedNamespace["admissionMode"];
    deployment_epoch: string;
    desired_deployment: string | null;
    quota_bytes: string;
  }>(
    "SELECT admission_mode, deployment_epoch, desired_deployment, quota_bytes " +
      "FROM compute.namespaces WHERE namespace_id = $1 FOR SHARE",
    [namespaceId],
  );
  const namespace = result.rows[0];
  if (namespace === undefined) {
    throw new ComputeError("NOT_FOUND", "Compute namespace was not found.");
  }
  return {
    admissionMode: namespace.admission_mode,
    deploymentEpoch: BigInt(namespace.deployment_epoch),
    desiredDeployment: namespace.desired_deployment,
    namespaceId,
    quotaBytes: BigInt(namespace.quota_bytes),
  };
}

export async function readReadyDeployment(
  transaction: ComputeQueryExecutor,
  namespace: LockedNamespace,
): Promise<ComputeDeploymentManifest> {
  if (namespace.desiredDeployment === null) {
    throw new ComputeError("DEPLOYMENT_UNAVAILABLE", "Namespace has no active deployment.");
  }
  const result = await transaction.query<{ manifest: unknown; status: string }>(
    "SELECT manifest, status FROM compute.deployments " + "WHERE namespace_id = $1 AND digest = $2",
    [namespace.namespaceId, namespace.desiredDeployment],
  );
  const deployment = result.rows[0];
  if (deployment === undefined || deployment.status !== "ready") {
    throw new ComputeError("DEPLOYMENT_UNAVAILABLE", "Namespace deployment is not ready.");
  }
  let manifest: ComputeDeploymentManifest;
  try {
    manifest = parseDeploymentManifest(deployment.manifest);
  } catch {
    throw new ComputeError("DEPLOYMENT_UNAVAILABLE", "Namespace deployment manifest is invalid.");
  }
  if (manifest.image !== namespace.desiredDeployment) {
    throw new ComputeError(
      "DEPLOYMENT_UNAVAILABLE",
      "Deployment manifest digest does not match its row.",
    );
  }
  return manifest;
}
