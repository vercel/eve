import { createHash } from "node:crypto";

import { createPostgresStorage } from "eve/internal/compute-platform";

import { computePlatformConfig } from "./config.ts";

const deploymentDigest = `sha256:${createHash("sha256")
  .update("eve-compute-local-a2", "utf8")
  .digest("hex")}`;
const manifest = {
  protocol: 1,
  image: deploymentDigest,
  artifactManifestHash: `sha256:${createHash("sha256")
    .update("eve-compute-local-a2-manifest", "utf8")
    .digest("hex")}`,
  definitions: [
    {
      id: "dev/counter",
      kind: "cell",
      module: "dev/counter.ts",
      export: "default",
      inputVersion: 1,
      stateVersion: 1,
      outputVersion: null,
      retry: null,
    },
  ],
};

export async function bootstrapLocalComputeNamespace(): Promise<void> {
  const storage = createPostgresStorage({
    applicationName: "eve-compute-local-bootstrap",
    connectionString: computePlatformConfig.migratorUrl,
    maxConnections: 1,
  });
  try {
    await storage.transaction(async (transaction) => {
      await transaction.query(
        "INSERT INTO compute.namespaces(namespace_id, project_id) " +
          "VALUES ($1, 'eve-compute-local') ON CONFLICT (namespace_id) DO NOTHING",
        [computePlatformConfig.namespaceId],
      );
      await transaction.query(
        "INSERT INTO compute.namespace_usage(namespace_id) VALUES ($1) " +
          "ON CONFLICT (namespace_id) DO NOTHING",
        [computePlatformConfig.namespaceId],
      );
      await transaction.query(
        "INSERT INTO compute.deployments(" +
          "namespace_id, digest, manifest, manifest_hash, status" +
          ") VALUES ($1, $2, $3::jsonb, $4, 'ready') " +
          "ON CONFLICT (namespace_id, digest) DO NOTHING",
        [
          computePlatformConfig.namespaceId,
          deploymentDigest,
          JSON.stringify(manifest),
          manifest.artifactManifestHash,
        ],
      );
      const deployment = await transaction.query<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM compute.deployments " +
          "WHERE namespace_id = $1 AND digest = $2",
        [computePlatformConfig.namespaceId, deploymentDigest],
      );
      if (deployment.rows[0]?.manifest_hash !== manifest.artifactManifestHash) {
        throw new Error("Local compute deployment digest has conflicting contents.");
      }
      await transaction.query(
        "UPDATE compute.namespaces SET " +
          "deployment_epoch = CASE WHEN desired_deployment IS DISTINCT FROM $2 " +
          "THEN deployment_epoch + 1 ELSE deployment_epoch END, " +
          "desired_deployment = $2 WHERE namespace_id = $1",
        [computePlatformConfig.namespaceId, deploymentDigest],
      );
    });
  } finally {
    await storage.close();
  }
}
