import { platformContext } from "#platform/context.js";

export const BUILD_DEPLOYMENT_ID_PATTERN = /^eve_[a-f0-9]{32}$/;

export function installWorkflowDeploymentId(deploymentId: string): void {
  if (!BUILD_DEPLOYMENT_ID_PATTERN.test(deploymentId)) return;
  if (
    platformContext().deployment.deploymentId() !== undefined ||
    process.env.WORKFLOW_DEPLOYMENT_ID
  ) {
    return;
  }
  process.env.WORKFLOW_DEPLOYMENT_ID = deploymentId;
}
