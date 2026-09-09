import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { defineTool } from "eve/tools";

import { createHarnessAgentTool } from "../lib/harness-agent";
import { runHarnessAgent } from "../lib/run-harness-agent";

const tool = createHarnessAgentTool({
  description: "Ask a software engineering expert to explain the current agent's code.",
  instructions:
    "You are a software engineering expert. You must answer the user's questions about the given code or project. You must not modify any code.",
});

export default defineTool({
  ...tool.definition,
  async execute(input, ctx) {
    const workDir = input.workDir ?? tool.agentSettings.workDir;
    return await runHarnessAgent({
      ...tool.agentSettings,
      abortSignal: ctx.abortSignal,
      harness: ({ port, portEndpoint }) => createClaudeCode({ port, portEndpoint }),
      sandbox: await ctx.getSandbox(),
      task: input.task,
      ...(workDir === undefined ? {} : { workDir }),
    });
  },
});
