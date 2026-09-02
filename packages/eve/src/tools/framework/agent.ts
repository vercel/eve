import type { z } from "#compiled/zod/index.js";
import { defineTool } from "#tools/definition.js";
import {
  AGENT_TOOL_DESCRIPTION,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#tools/framework/agent-contract.js";
import { SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA } from "#tools/framework/task-contract.js";
import { attachToolBehavior } from "#tools/behavior.js";

export const agent = attachToolBehavior(
  defineTool({
    description: `${AGENT_TOOL_DESCRIPTION} This call starts a background task and returns a task receipt immediately.`,
    execution: "background",
    inputSchema: SUBAGENT_TOOL_INPUT_SCHEMA,
    outputSchema: SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA,
    // `defineTool` requires a body, but the runtime tool registry rebinds this
    // tool to the shared subagent workflow before it can ever run.
    execute(): z.infer<typeof SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA> {
      "use workflow";
      throw new Error(
        'The framework "agent" tool was executed directly. It must be resolved through the runtime tool registry, which dispatches it to the shared subagent workflow.',
      );
    },
  }),
  { availability: ["root-session"], handling: { action: "self-agent", kind: "dispatch" } },
);

export default agent;
