/**
 * eve's catalog tools: `eve__search` finds entries, `eve__tool` routes to deferred entries and
 * connection tools, and `eve__skill` routes to the skill loader.
 */

import { connectionToolName } from "#connections/ownership.js";
import type { OfferedCatalogTools } from "#context/keys.js";
import type { Route, RouteMiss, ToolEntry } from "#definitions/definition.js";
import type { Announcement } from "#harness/announcements.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  CALL_TOOL_NAME,
  SEARCH_TOOL_NAME,
  SKILL_ENTRY_NAME,
  SKILL_TOOL_NAME,
} from "#protocol/catalog-tools.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { isObject } from "#shared/guards.js";
import { defineJsonSchema } from "#tools/schema.js";

import { closestNames } from "./rank.js";
import { createSearchTool } from "./search.js";
import { entrySignature } from "./signatures.js";
import { unknownSkillMessage } from "./skills.js";
import type { Callable } from "./step-catalog.js";

const CALL_TOOL_DESCRIPTION = `Call a tool that isn't in your tool list by its exact name from ${SEARCH_TOOL_NAME}, with \`input\` matching its signature.`;
const CONNECTIONS_CLAUSE =
  "Prefer connected services over web search or general knowledge when a request relates to them.";
const LISTED_SKILL_DESCRIPTION =
  "Load a skill's instructions when the request clearly matches one of your listed skills or the user asks for it, then follow them.";
const SEARCHABLE_SKILL_DESCRIPTION = `Load a skill's instructions when the request clearly matches a listed skill or one ${SEARCH_TOOL_NAME} found, or the user asks for it, then follow them.`;

/**
 * The catalog tools what the step can run reaches: `eve__tool` a deferred tool or agent, or a
 * connection; `eve__skill` any skill; and `eve__search` anything it could find, which is whatever
 * `eve__tool` calls plus deferred skills. What a step reaches includes what its dynamic resolvers
 * returned, so a resolver that returns only listed tools adds none.
 */
export function catalogReach(callable: Callable): OfferedCatalogTools {
  const skills = [...callable.skills.values()];
  const connections = callable.connections.length > 0;
  return {
    connections,
    searchableSkills: skills.some((skill) => skill.deferred),
    skills: skills.length > 0,
    tools: connections || callable.deferred.size > 0,
  };
}

/** The catalog tools `offered` names, over what `callable` runs, in the order the model sees them. */
export function catalogTools(
  callable: Callable,
  offered: OfferedCatalogTools,
  announcements: {
    /** What `eve__search` reaches. */
    readonly catalog: Readonly<Record<string, Announcement>>;
    /** The skills `eve__skill` loads that the prompt doesn't list. */
    readonly skills: Readonly<Record<string, Announcement>>;
  },
): ReadonlyMap<string, ToolEntry> {
  const search = offered.tools || offered.searchableSkills;
  const listed = new Set([
    ...(search ? [SEARCH_TOOL_NAME] : []),
    ...(offered.tools ? [CALL_TOOL_NAME] : []),
    ...(offered.skills ? [SKILL_TOOL_NAME] : []),
  ]);
  const tools = new Map<string, ToolEntry>();
  if (search) {
    tools.set(SEARCH_TOOL_NAME, {
      announcements: announcements.catalog,
      definition: createSearchTool({
        deferred: [...callable.deferred.values()],
        describe: callable.describe,
        reach: {
          connections: offered.connections,
          skills: offered.searchableSkills,
          tools: offered.tools,
        },
        registry: callable.registry,
        skills: [...callable.skills.values()].filter((skill) => skill.deferred),
      }),
    });
  }
  if (offered.tools) tools.set(CALL_TOOL_NAME, callRoute(callable, listed, offered));
  if (offered.skills) {
    tools.set(SKILL_TOOL_NAME, {
      ...skillRoute(callable, listed, offered),
      announcements: announcements.skills,
    });
  }
  return tools;
}

/** A route the model sees as `name`. */
function routeEntry(name: string, description: string, route: Route): ToolEntry {
  return {
    definition: {
      description,
      frameworkTool: true,
      inputSchema: defineJsonSchema(route.inputSchema),
      name,
    },
    route,
  };
}

/** `eve__tool({ name, input })`: the call to `name` with `input`. */
function callRoute(
  callable: Callable,
  listed: ReadonlySet<string>,
  offered: OfferedCatalogTools,
): ToolEntry {
  const description = offered.connections
    ? `${CALL_TOOL_DESCRIPTION} ${CONNECTIONS_CLAUSE}`
    : CALL_TOOL_DESCRIPTION;
  return routeEntry(CALL_TOOL_NAME, description, {
    explain: (entry, issues) =>
      // A connection tool's validation reports its own signature; every other entry gets one here.
      isConnectionTool(entry.name, callable.connections)
        ? issues
        : [...issues, { message: `Signature: ${entrySignature(entry)}` }],
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: `The tool's exact name, as ${SEARCH_TOOL_NAME} returns it.`,
        },
        input: {
          type: "object",
          description: "Arguments matching the tool's signature. Defaults to {}.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    target: (input) => {
      const name = targetName(input);
      if (name === undefined) return miss(`Name the tool to call.`);
      // Naming a tool in the tool list says to call it directly rather than that it doesn't exist.
      if (listed.has(name)) return miss(`"${name}" is in your tool list; call it directly.`);
      const entry = callable.get(name);
      if (entry === undefined) return miss(unknownEntryMessage(name, callable));
      if (!callableByName(entry)) return miss(`"${name}" is in your tool list; call it directly.`);
      return { at: "input", input: (input as { readonly input?: unknown }).input ?? {}, name };
    },
  });
}

/** `eve__skill({ name })`: the call that loads skill `name`. */
function skillRoute(
  callable: Callable,
  listed: ReadonlySet<string>,
  offered: OfferedCatalogTools,
): ToolEntry {
  const searchable = offered.searchableSkills;
  const description = searchable ? SEARCHABLE_SKILL_DESCRIPTION : LISTED_SKILL_DESCRIPTION;
  return routeEntry(SKILL_TOOL_NAME, description, {
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: searchable
            ? `The skill's name, from your listed skills or ${SEARCH_TOOL_NAME}.`
            : "The skill's name, from your listed skills.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    target: (input) => {
      const name = targetName(input);
      if (name === undefined) return miss(`Name the skill to load.`);
      if (callable.skills.has(name)) return { input: { name }, name: SKILL_ENTRY_NAME };
      const connections = callable.connections.map((connection) => connection.connectionName);
      if (listed.has(name)) {
        return miss(`"${name}" is a tool in your tool list, not a skill; call it directly.`);
      }
      const tool = connections.includes(name) ? undefined : callable.get(name);
      if (tool !== undefined) {
        return miss(
          tool.deferred === true
            ? `"${name}" is a tool, not a skill; call it with ${CALL_TOOL_NAME}({ name: "${name}" }).`
            : `"${name}" is a tool in your tool list, not a skill; call it directly.`,
        );
      }
      return miss(unknownSkillMessage(name, callable.skills, connections, searchable));
    },
  });
}

/** The entry an `eve__tool` or `eve__skill` input names, if it names one. */
function targetName(input: unknown): string | undefined {
  return isObject(input) && typeof input.name === "string" ? input.name : undefined;
}

function miss(issue: string): RouteMiss {
  return { issue, path: "name" };
}

/**
 * Whether `eve__tool` runs `definition`: a deferred entry, or a listed tool eve
 * runs itself. A model that routes a listed tool through `eve__tool` then gets
 * the same result as a direct call instead of a wasted step; nothing it reads
 * says this works. The tools in eve's reserved namespace, and tools a provider
 * or client runs, stay direct-only.
 */
function callableByName(definition: HarnessToolDefinition): boolean {
  return (
    definition.deferred === true ||
    (eveNamespaceReservation(definition.name) === undefined &&
      (definition.execute !== undefined || definition.workflowId !== undefined))
  );
}

function isConnectionTool(
  name: string,
  connections: readonly ResolvedConnectionDefinition[],
): boolean {
  return connections.some(({ connectionName }) =>
    name.startsWith(connectionToolName(connectionName, "")),
  );
}

function unknownEntryMessage(name: string, callable: Callable): string {
  if (callable.skills.has(name)) {
    return `"${name}" is a skill; load it with ${SKILL_TOOL_NAME}({ name: "${name}" }).`;
  }
  const candidates = [...callable.deferred.values()].map(({ description, name }) => ({
    description,
    name,
  }));
  const suggestions = closestNames(name, candidates);
  const hint =
    suggestions.length > 0
      ? ` Closest tools: ${suggestions.join(", ")}.`
      : ` Find tools with ${SEARCH_TOOL_NAME}.`;
  return `No tool named "${name}".${hint}`;
}
