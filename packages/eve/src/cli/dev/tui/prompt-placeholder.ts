import type { AgentInfoResult, AgentInfoSource } from "#client/agent-info-schema.js";
import { AGENT_INSTRUCTIONS_TEMPLATE } from "#setup/scaffold/create/instructions-template.js";

const MESSAGE = "Send a message…";

function isSelfModification(source: AgentInfoSource): boolean {
  return (
    source.owner.kind === "extension" &&
    source.owner.packageName === "eve" &&
    source.owner.namespace === "self-modification"
  );
}

function isApplicationCapability(source: AgentInfoSource): boolean {
  return source.owner.kind !== "framework" && !isSelfModification(source);
}

export function initialPromptPlaceholder(
  info: AgentInfoResult | undefined,
  localDevelopment: boolean,
): string {
  if (
    !localDevelopment ||
    info === undefined ||
    info.mode !== "development" ||
    info.diagnostics.discoveryErrors > 0 ||
    !info.subagents.local.some(
      (entry) => entry.name === "self-modification__agent" && isSelfModification(entry),
    )
  ) {
    return MESSAGE;
  }

  // The scaffold's eve channel is the TUI/web transport, not an added integration.
  if (
    info.channels.routes.some(
      (entry) =>
        isApplicationCapability(entry) &&
        !(entry.name === "eve" && entry.urlPath.startsWith("/eve/")),
    )
  ) {
    return MESSAGE;
  }

  const instructions = info.instructions.static.filter(isApplicationCapability);
  if (info.instructions.dynamic.some(isApplicationCapability) || instructions.length === 0) {
    return MESSAGE;
  }

  const hasCapabilities = [
    ...info.tools.static,
    ...info.tools.dynamic,
    ...info.skills.static,
    ...info.skills.dynamic,
    ...info.connections,
    ...info.schedules,
    ...info.hooks,
    ...info.memories,
    ...info.subagents.local,
    ...info.remoteAgents.entries,
  ].some(isApplicationCapability);
  const [instructionsFile] = instructions;
  const isScaffold =
    instructions.length === 1 &&
    instructionsFile?.owner.kind === "application" &&
    instructionsFile.logicalPath === "instructions.md" &&
    instructionsFile.content.trim() === AGENT_INSTRUCTIONS_TEMPLATE.trim();

  return isScaffold && !hasCapabilities
    ? "Ask me to connect a channel, edit instructions, add a tool…"
    : "Send a message, or ask me to add a channel…";
}
