import { getWorkflowMetadata } from "workflow";

import { UPGRADE_MARKER } from "./upgrade-marker.ts";

/** Captures the actual executable and owner so a resumed old turn cannot pass as a new one. */
export async function readUpgradeExecution() {
  "use step";

  return {
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? "local",
    marker: UPGRADE_MARKER,
    runId: getWorkflowMetadata().workflowRunId,
  };
}
