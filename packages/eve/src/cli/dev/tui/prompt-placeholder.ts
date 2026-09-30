import type { AgentInfoResult, AgentInfoSource } from "#client/agent-info-schema.js";
import { AGENT_INSTRUCTIONS_TEMPLATE } from "#setup/scaffold/create/instructions-template.js";
import { SCAFFOLDED_AGENT_PATHS } from "#setup/scaffold/create/agent-paths.js";
import { SELF_MODIFICATION_AGENT_NAME } from "./tool-presentation.js";

const MESSAGE = "Send a message…";
const scaffoldedSourcePaths = new Set(
  Object.values(SCAFFOLDED_AGENT_PATHS).map((path) => path.slice("agent/".length)),
);

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

function isAddedCapability(source: AgentInfoSource): boolean {
  return (
    isApplicationCapability(source) &&
    !(source.owner.kind === "application" && scaffoldedSourcePaths.has(source.logicalPath))
  );
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
      (entry) => entry.name === SELF_MODIFICATION_AGENT_NAME && isSelfModification(entry),
    )
  ) {
    return MESSAGE;
  }

  if (info.channels.routes.some(isAddedCapability)) return MESSAGE;

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
  ].some(isAddedCapability);
  const [instructionsFile] = instructions;
  const isScaffold =
    instructions.length === 1 &&
    instructionsFile?.owner.kind === "application" &&
    instructionsFile.logicalPath === SCAFFOLDED_AGENT_PATHS.instructions.slice("agent/".length) &&
    instructionsFile.content.trim() === AGENT_INSTRUCTIONS_TEMPLATE.trim();

  return isScaffold && !hasCapabilities
    ? "Ask me to connect a channel, edit instructions, add a tool…"
    : "Send a message, or ask me to add a channel…";
}
