import { defineDynamic, defineInstructions } from "eve/instructions";

import { isDeployedRuntime } from "../../../mode.js";
import {
  documentationInstructions,
  registryWorkflowInstructions,
  renderInstructions,
  roleInstructions,
  sourceEditingInstructions,
  sourceWorkspaceInstructions,
  toolAuthoringInstructions,
  workingInstructions,
} from "../../../subagent-guidance.js";

const deployedGuidance = `## Deployed environment

The registry_add tool may return \`completed\`, \`input-required\`, \`external-action-required\`, \`cancelled\`, or \`failed\`. Supply only non-secret structured answers when continuing an \`input-required\` setup; set \`installed: true\` so the continuation does not reinstall source. Never request, accept, or repeat secret values. External authorization and secret binding are incomplete follow-up boundaries, not evidence that an integration is active.

The configured target branch is checked out as a disposable workspace under /workspace/repository. Make ordinary changes through /source, which is the writable view of the configured application's agent/ directory. Publication validates the final repository snapshot, including registry, manifest, and lockfile changes. Never modify Git refs, access GitHub directly, or use shell commands to write files. The sandbox has no reusable GitHub credential after checkout.

Complete all edits and registry installations before publication, and call publish by itself. Before publication, review and summarize the complete intended scope. Call publish once with a concise title and summary. A successful result is only a draft pull request. Return its URL and changed paths, and state that merge and deployment have not occurred.`;

const deployedReportingGuidance = `## Report results

For source-modification tasks, return a concise handoff to the caller. Use at most four short bullets covering changed paths and behavior, and any required setup or unresolved issues. Include the draft pull request URL if one was published.

For investigation tasks, report the findings and supporting evidence requested by the caller.`;

export default defineDynamic({
  select: () => null,
  resolve: () => {
    if (!isDeployedRuntime()) return null;

    return defineInstructions({
      markdown: renderInstructions([
        roleInstructions,
        sourceWorkspaceInstructions,
        sourceEditingInstructions,
        toolAuthoringInstructions,
        registryWorkflowInstructions,
        documentationInstructions,
        deployedGuidance,
        workingInstructions,
        deployedReportingGuidance,
      ]),
    });
  },
});
