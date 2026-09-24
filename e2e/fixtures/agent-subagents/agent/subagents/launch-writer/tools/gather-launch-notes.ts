import { defineWorkflowTool, type WorkflowToolDefinition } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

interface LaunchNotes {
  readonly audience: string;
  readonly highlights: readonly string[];
  readonly launchDate: string;
  readonly product: string;
}

// Slow on purpose: the requester's turn ends, and a follow-up can arrive, while the draft is in progress.
async function execute(): Promise<LaunchNotes> {
  "use workflow";
  await sleep("20s");
  return {
    audience: "Teams that plan projects together",
    highlights: ["Shared boards that sync offline", "A weekly summary of every board"],
    launchDate: "October 14",
    product: "Orbit Notebook",
  };
}

const tool: WorkflowToolDefinition<Record<string, never>, LaunchNotes> = defineWorkflowTool({
  description: "Collect the launch notes for the Orbit Notebook. Takes about 20 seconds.",
  inputSchema: z.object({}),
  execute,
});

export default tool;
