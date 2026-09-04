import type { Command } from "#compiled/commander/index.js";
import type { AgentWorkspace } from "#internal/project-context.js";

import type { CliApplicationContext } from "./application-command.js";

export type AgentCommandRequirement = (command: Command) => boolean;

async function selectWorkspaceAgent(
  workspace: AgentWorkspace,
  requestedName: string | undefined,
): Promise<string> {
  const names = workspace.members.map((member) => member.name);
  if (requestedName !== undefined) {
    const member = workspace.members.find((candidate) => candidate.name === requestedName);
    if (member === undefined) {
      throw new Error(
        `Unknown agent ${JSON.stringify(requestedName)}. Available agents: ${names.join(", ")}.`,
      );
    }
    return member.appRoot;
  }
  if (workspace.members.length === 1) return workspace.members[0]!.appRoot;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error(
      `This command requires a specific agent. Pass --agent <name>. Available agents: ${names.join(", ")}.`,
    );
  }
  const { createPrompter } = await import("#setup/prompter.js");
  const name = await createPrompter().select({
    message: "Select an agent",
    options: workspace.members.map((member) => ({ label: member.name, value: member.name })),
    search: workspace.members.length > 8,
  });
  return workspace.members.find((member) => member.name === name)!.appRoot;
}

/** Adds consistent workspace-agent selection to an agent-scoped command. */
export function agentCommand(
  command: Command,
  applicationContext: CliApplicationContext,
  requirement: AgentCommandRequirement = () => true,
): Command {
  command.option("--agent <name>", "Select an agent from an agents/ workspace");
  return command.hook("preAction", async (_command, actionCommand) => {
    const requestedName = actionCommand.opts<{ agent?: string }>().agent;
    if (!requirement(actionCommand)) {
      if (requestedName !== undefined) {
        throw new Error("--agent cannot be combined with a remote URL target.");
      }
      return;
    }

    const initialSelection = await applicationContext.resolveAgent();
    if (initialSelection.kind === "workspace") {
      applicationContext.root = await selectWorkspaceAgent(
        initialSelection.workspace,
        requestedName,
      );
      await applicationContext.resolve();
      return;
    }

    await applicationContext.resolve();
    const resolvedSelection = await applicationContext.resolveAgent();
    if (requestedName !== undefined) {
      if (
        resolvedSelection.kind !== "workspace-member" ||
        resolvedSelection.member.name !== requestedName
      ) {
        throw new Error("--agent can only select a member of the enclosing agents/ workspace.");
      }
    }
  });
}
