import { defineInstructions } from "eve/instructions";

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
import { defineLocalOnlyDynamic } from "../../local-only.js";

const localReportingGuidance = `## Report results

For source-modification tasks, return a concise handoff to the caller. Use at most four short bullets covering changed paths and behavior, and any required setup or unresolved issues.

For investigation tasks, report the findings and supporting evidence requested by the caller.`;

const localGuidance = `## Local environment

You are running directly on the host in the project root while \`eve dev\` watches and reloads authored files automatically.

- Use \`registry_add\` (never run \`eve add\` in \`bash\`) to install eve registry items. \`registry_add\` completes installation for items that need no setup. In the local dev TUI, a \`needs-terminal\` result queues the existing setup panel, which opens after your reply and reports the setup outcome itself. Until then nothing is installed: say that setup continues in the panel and never describe the item as added, connected, or set up. In headless development, if a \`needs-terminal\` result includes \`nextCommand\`, present that exact value as the only shell command in your response. Never infer, construct, or rewrite a command: installing an item uses \`eve add <item>\`; \`eve registry add\` configures registry namespace mappings and does not install items.
- Local \`eve dev\` logs live under \`.eve/logs\`, and local trace segments live under \`.eve/traces/v1\` when available. For latency, failure, token, or behavior analysis, load and follow the \`trace_analysis\` skill. Trace searches are scoped to the invoking conversation and exclude the current investigation by default.
- Read \`package.json\`, \`tsconfig.json\`, \`AGENTS.md\`, or \`CLAUDE.md\` when relevant to the task. You may run targeted read-only verification commands (such as \`tsc --noEmit\` or focused tests) when helpful, without adding unrequested files.
- Never run \`eve dev\`, \`eve build\`, or \`eve add\` in \`bash\`, never start long-lived servers, never run destructive \`git\` commands (\`git reset --hard\`, \`git checkout --\`), preserve unrelated user changes, and never print credentials, tokens, or \`.env\` file contents.`;

const selfModificationSubagentGuidance = `## Changing the self-modification subagent

Only when the requester explicitly names the self-modification subagent, edit whichever of \`agent/extensions/self.ts\`, \`agent/extensions/self/extension.ts\`, \`agent/extensions/self-modification.ts\`, or \`agent/extensions/self-modification/extension.ts\` exists. If none exists, create \`agent/extensions/self/extension.ts\` with \`write_file\` using this content, then make the requested model or reasoning change:
\`\`\`ts
${renderLocalSelfModificationExtension()}\`\`\``;

export default defineLocalOnlyDynamic(
  defineInstructions({
    content: renderInstructions([
      roleInstructions,
      sourceWorkspaceInstructions("agent"),
      sourceEditingInstructions,
      toolAuthoringInstructions("agent"),
      registryWorkflowInstructions,
      documentationInstructions("node_modules/eve/docs"),
      localGuidance,
      workingInstructions,
      selfModificationSubagentGuidance,
      localReportingGuidance,
    ]),
  }),
);
