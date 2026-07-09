import { loadContext } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { getAvailableSkillNames } from "#context/available-skills.js";
import { loadSkillFromSandbox } from "#runtime/skills/sandbox-access.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { JsonObject } from "#shared/json.js";

/**
 * Typed input accepted by {@link executeLoadSkillTool}.
 */
interface LoadSkillInput {
  readonly skill: string;
}

/**
 * Executes the `load_skill` tool.
 *
 * Reads the requested skill's `SKILL.md` from the active sandbox and
 * returns it as the tool result.
 */
async function executeLoadSkillTool(args: LoadSkillInput): Promise<unknown> {
  const ctx = loadContext();
  const sandbox = ctx.get(SandboxKey);

  if (sandbox === undefined) {
    throw new Error(
      "The load_skill tool requires sandbox access on the runtime context. " +
        "Ensure the step is running inside a managed runtime context with sandbox support.",
    );
  }

  const { skill } = args;
  const availableSkills = availableSkillNames(ctx);
  try {
    return await loadSkillFromSandbox(sandbox, skill, {
      availableSkillNames: availableSkills,
      enforceAvailableSkills: true,
    });
  } catch (error) {
    const connectionName = ctx
      .get(ConnectionRegistryKey)
      ?.getConnectionNames()
      .find((name) => name.toLowerCase() === skill.toLowerCase());
    if (connectionName === undefined || availableSkills.includes(skill)) throw error;

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} "${connectionName}" is an installed connection, not a skill. ` +
        `Use connection_search with connection "${connectionName}" to find its tools.`,
      { cause: error },
    );
  }
}

function availableSkillNames(ctx: ReturnType<typeof loadContext>): string[] {
  return getAvailableSkillNames(ctx);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const SKILL_OUTPUT_SCHEMA: JsonObject = { type: "string" };

export const SKILL_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Load the full instructions for one available skill by name or id.",
    "Use this tool when the request clearly matches a listed skill description or when the user explicitly asks for that skill.",
    "This is not for MCP connections; use connection_search to access an installed connection.",
    "Loading adds the skill instructions to the current turn.",
    'Choose the "skill" value from the Available skills block.',
  ].join(" "),
  execute: (input) => executeLoadSkillTool(input as LoadSkillInput),
  inputSchema: {
    additionalProperties: false,
    properties: {
      skill: {
        description: "Available skill name or id.",
        type: "string",
      },
    },
    required: ["skill"],
    type: "object",
  },
  logicalPath: "eve:framework/load-skill",
  name: "load_skill",
  outputSchema: SKILL_OUTPUT_SCHEMA,
  sourceId: "eve:load-skill-tool",
  sourceKind: "module",
};
