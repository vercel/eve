import { sandboxDefinitionOf } from "#runtime/sessions/code-agent.js";
import type { CodeAgent } from "#runtime/sessions/session-agent.js";

// What `/info` shows for an agent defined in code. A file agent's `/info` inspects its compiled
// application; a code agent has none, so this lists what its definitions are.

const TOOL_PREFIX = "tool::";

/** The agent's name, revision, tools and definitions, one per line. */
export async function describeAgent(agent: CodeAgent): Promise<string> {
  const [revision, definitions] = await Promise.all([agent.revision(), agent.definitions()]);
  const tools = definitions.filter(({ id }) => id.startsWith(TOOL_PREFIX));
  const eves = definitions.filter(({ id }) => id.startsWith("eve."));
  const own = definitions.filter(
    (definition) => !tools.includes(definition) && !eves.includes(definition),
  );
  const sandbox = sandboxDefinitionOf(definitions);
  return [
    `${agent.name ?? agent.id} · defined in code · revision ${revision}`,
    `Tools: ${tools.map(({ id }) => id.slice(TOOL_PREFIX.length)).join(", ") || "none"}`,
    `Sandbox: ${sandbox === undefined ? "none" : `from ${sandbox.label}`}`,
    `Its definitions: ${own.map(({ label }) => label).join(", ") || "none"}`,
    `eve's: ${eves.map(({ id }) => id).join(", ")}`,
  ].join("\n");
}
