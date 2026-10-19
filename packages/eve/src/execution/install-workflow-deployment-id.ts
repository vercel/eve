export const BUILD_DEPLOYMENT_ID_PATTERN = /^eve_[a-f0-9]{32}$/;

/** Installs the artifact identity before a production Workflow World is constructed. */
export function installWorkflowDeploymentId(deploymentId: string): void {
  // The bundle must contain the placeholder exactly once, so the unpatched
  // (development or non-node-server) value is recognized by shape, not by import.
  if (!BUILD_DEPLOYMENT_ID_PATTERN.test(deploymentId)) return;
  // Vercel supplies its own identity; an explicit operator value wins.
  if (process.env.VERCEL_DEPLOYMENT_ID || process.env.WORKFLOW_DEPLOYMENT_ID) return;
  process.env.WORKFLOW_DEPLOYMENT_ID = deploymentId;
}
