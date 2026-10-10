import { defineDynamic, defineInstructions } from "eve/instructions";

import { resolveSelfModificationConfig } from "../../../config.js";
import { isLocalSelfModificationEnabled } from "../../../mode.js";
import { renderLocalSelfModificationExtension } from "../../../scaffold.js";
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
import selfModification from "../../extension.js";

const localReportingGuidance = `## Report results

For source-modification tasks, return a concise handoff to the caller. Use at most four short bullets covering changed paths and behavior, and any required setup or unresolved issues.

For investigation tasks, report the findings and supporting evidence requested by the caller.`;

const localGuidance = `## Local environment

The registry_add tool will complete installation for items that need no setup. In the local dev TUI, a \`needs-terminal\` result queues the existing setup panel, which opens after your reply and reports the setup outcome itself. Until then nothing is installed: say that setup continues in the panel and never describe the item as added, connected, or set up. In headless development, if a \`needs-terminal\` result includes \`nextCommand\`, present that exact value as the only shell command in your response. Never infer, construct, or rewrite a command: installing an item uses \`eve add <item>\`; \`eve registry add\` configures registry namespace mappings and does not install items.

Local eve dev logs are mounted read-only at /logs. Local trace segments are mounted read-only at /traces when available. For latency, failure, token, or behavior analysis, load and follow the \`trace_analysis\` skill. Trace searches are scoped to the invoking conversation and exclude the current investigation by default.

The application package.json is not mounted. Do not search outside /source for application files. You cannot run host binaries such as git, node, pnpm, or tsc. Use existing imports and registry_add for supported registry installations.`;

const selfModificationSubagentGuidance = `## Changing the self-modification subagent

Only when the requester explicitly names the self-modification subagent, edit whichever of /source/extensions/self-modification.ts or /source/extensions/self-modification/extension.ts exists. If neither exists, create /source/extensions/self-modification/extension.ts with write_file using this content, then make the requested model or reasoning change:
\`\`\`ts
${renderLocalSelfModificationExtension()}\`\`\``;

export default defineDynamic({
  select: () => null,
  resolve: () => {
    if (!isLocalSelfModificationEnabled(resolveSelfModificationConfig(selfModification.config))) {
      return null;
    }

    return defineInstructions({
      markdown: renderInstructions([
        roleInstructions,
        sourceWorkspaceInstructions,
        sourceEditingInstructions,
        toolAuthoringInstructions,
        registryWorkflowInstructions,
        documentationInstructions,
        localGuidance,
        workingInstructions,
        selfModificationSubagentGuidance,
        localReportingGuidance,
      ]),
    });
  },
});
