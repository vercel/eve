import type { AgentWorkspace } from "#internal/project-context.js";
import { buildHomePageHtml } from "#internal/nitro/routes/index.js";

export function buildMultiAgentLandingPage(workspace: AgentWorkspace): string {
  const agentCount = workspace.members.length;
  return buildHomePageHtml({
    name: "eve agents",
    statusDetail: `${agentCount} ${agentCount === 1 ? "agent is" : "agents are"} up and accepting messages.`,
  });
}
