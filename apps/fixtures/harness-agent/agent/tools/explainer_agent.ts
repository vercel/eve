import { defineTool } from "eve/tools";

import { settings } from "../lib/explainer_agent/settings";
import { createHarnessAgentToolDefinition } from "../lib/harness-agent-tool-definition";
import { runHarnessAgent } from "../lib/run-harness-agent";

export default defineTool({
  ...createHarnessAgentToolDefinition({
    description: "Ask a software engineering expert to explain the current agent's code.",
    settings,
  }),
  async execute(input, ctx) {
    return await runHarnessAgent({
      ctx,
      input,
      settings,
    });
  },
});
