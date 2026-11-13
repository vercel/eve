import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { SessionAgentSettings } from "#runtime/sessions/session-agent.js";
import type {
  AgentReasoningDefinition,
  AgentWorkflowRetentionDefinition,
  SessionUsageLimit,
} from "#shared/agent-definition.js";
import { approvals } from "./approvals.js";
import { builtins } from "./builtins.js";
import { catalog } from "./catalog.js";
import { connections as eveConnections } from "./connections.js";
import type { Definition } from "./definition.js";
import {
  instructions as eveInstructions,
  type StaticInstruction,
  staticInstructionsDefinition,
  workspace,
} from "./instructions.js";
import { parentModel } from "./model.js";
import { skills as eveSkills } from "./skills.js";
import { staticTools } from "./tools.js";

// One path from an agent's contents to the definitions its sessions run. An agent compiled from an
// `agent/` directory maps its node's files to them (`#definitions/compiled-agent.js`); any other
// kind of agent maps its own fields the same way. Each field arrives as the definitions its
// builder made, the same builder whichever kind of agent it is; this module owns where each goes,
// and what the agent's settings are.

/**
 * An agent's contents: each field of `defineAgent`, or each kind of file in `agent/`, as the
 * definitions its builder made.
 */
export interface AgentContents {
  /** The model, as `model` (or `agent.ts`'s) chooses it. The last choice wins. */
  readonly model: readonly Definition[];
  /**
   * Instructions the same in every session (`instructions: "..."`), as `instructions.md` states
   * them: one block of eve's prompt. A compiled agent's are its node's, which eve reads itself.
   */
  readonly staticInstructions?: readonly StaticInstruction[];
  /** Instructions chosen per session: `instructions` as a function, or `agent/instructions/*`. */
  readonly instructions: readonly Definition[];
  /** `connections`, or `agent/connections/*`. */
  readonly connections: readonly Definition[];
  /** Further definitions the agent adds, such as eve's defaults. */
  readonly definitions: readonly Definition[];
  /**
   * `subagents`: after the agent's own tools, where a compiled node's subagents sit in its tool
   * table. A compiled node's are in that table already.
   */
  readonly subagents: readonly Definition[];
  /** `tools`, or `agent/tools/*`. */
  readonly tools: readonly Definition[];
  /** `skills`, or `agent/skills/*`. */
  readonly skills: readonly Definition[];
  /** Leave out eve's runtime definitions (instructions, connections, catalog, ...). */
  readonly bare?: boolean;
  /**
   * What only an `agent/` directory declares, with no `defineAgent` field yet, at the positions
   * its files take. Internal: nothing public builds these.
   */
  readonly files?: {
    /** `agent/hooks/*`: first, so each hook sees the session before anything else contributes. */
    readonly hooks: readonly Definition[];
    /** `agent/subagents/*` chosen at runtime (`defineDynamic`): after eve's static tools. */
    readonly dynamicSubagents: readonly Definition[];
    /** `agent/memory*` and the tools a memory offers: after those, before tools. */
    readonly memory: readonly Definition[];
    /** The tools a schedule collection offers: after tools, before skills. */
    readonly scheduleTools: readonly Definition[];
  };
}

/**
 * The definitions an agent's sessions run, in the order that is their contract. Definitions
 * contribute in it, and each arrangement wraps what the ones before it left:
 *
 * - The first to offer a tool name keeps it. So eve's static tools (a compiled node's static tool
 *   files and eve's defaults among them) come before dynamic ones, and connections keep theirs
 *   before tools and subagents check names against them.
 * - eve's skills listing, approvals, builtins and catalog come after everything the agent
 *   declares, so they see all of it: the catalog indexes the final tool table.
 * - The last model choice wins, and a parent's choice comes last, so it's the one the session runs.
 * - Among the contents' fields, one definition per id: a later one takes an earlier one's place,
 *   as an agent's own `bash` replaces eve's default (`definitions: eve.defaults()`) where it stood.
 *   A file's entries (`files`) and eve's runtime definitions are never replaced.
 */
export function agentDefinitionsOf(contents: AgentContents): readonly Definition[] {
  const eve = (definition: Definition): readonly Definition[] =>
    contents.bare === true ? [] : [definition];
  const own = overriding([
    contents.model,
    contents.instructions,
    contents.connections,
    contents.definitions,
    contents.subagents,
    contents.tools,
    contents.skills,
  ]);
  const files = contents.files;
  const staticInstructions = contents.staticInstructions;
  return [
    ...(files?.hooks ?? []),
    ...own(contents.model),
    // The agent's own static instructions in eve's slot, bare or not; else eve's, which reads a
    // compiled node's.
    ...(staticInstructions === undefined
      ? eve(eveInstructions)
      : [staticInstructionsDefinition(() => staticInstructions)]),
    ...own(contents.instructions),
    ...eve(workspace),
    ...eve(eveConnections),
    ...own(contents.connections),
    ...eve(staticTools),
    ...own(contents.definitions),
    ...(files?.dynamicSubagents ?? []),
    ...(files?.memory ?? []),
    ...own(contents.tools),
    ...own(contents.subagents),
    ...(files?.scheduleTools ?? []),
    ...own(contents.skills),
    ...eve(eveSkills),
    ...eve(approvals),
    ...eve(builtins),
    ...eve(catalog),
    ...eve(parentModel),
  ];
}

/**
 * Places `fields`' definitions one per id: each id at its first place, holding the last
 * definition with it. Call the result on each field in the order they're placed.
 */
function overriding(
  fields: readonly (readonly Definition[])[],
): (field: readonly Definition[]) => readonly Definition[] {
  const last = new Map<string, Definition>();
  for (const definition of fields.flat()) last.set(definition.id, definition);
  const placed = new Set<string>();
  return (field) =>
    field.flatMap((definition) => {
      const winner = last.get(definition.id);
      if (winner === undefined || placed.has(definition.id)) return [];
      placed.add(definition.id);
      return [winner];
    });
}

/** What an agent's configuration sets for its sessions, resolved, as `settingsOf` takes it. */
export interface AgentSettingsFields {
  /** The compaction summary's model, by reference. */
  readonly compactionModel?: RuntimeModelReference;
  /** `compaction.threshold`, as the share of the context window that triggers it. */
  readonly compactionThresholdPercent?: number;
  readonly sessionTimeoutMs?: number | false;
  /** `limits.sessionUsage`, read when a turn first asks for it. `false` turns it off. */
  readonly sessionUsage?: () => SessionUsageLimit | false | undefined;
  /** `experimental.workflow.modelCallsPerStep`. */
  readonly modelCallsPerStep?: number;
  readonly reasoning?: AgentReasoningDefinition;
  /** `experimental.workflow.retention`. */
  readonly retention?: AgentWorkflowRetentionDefinition;
}

/** An agent's settings, as the session-agent port names them. */
export function settingsOf(fields: AgentSettingsFields): SessionAgentSettings {
  let sessionUsage: { readonly limit: SessionUsageLimit | undefined } | undefined;
  return {
    compaction: {
      model: fields.compactionModel,
      thresholdPercent: fields.compactionThresholdPercent,
    },
    limits: {
      sessionTimeoutMs: fields.sessionTimeoutMs,
      get sessionUsage() {
        sessionUsage ??= { limit: usageLimit(fields.sessionUsage?.()) };
        return sessionUsage.limit;
      },
    },
    modelCallsPerStep: fields.modelCallsPerStep,
    reasoning: fields.reasoning,
    retention: fields.retention,
  };
}

function usageLimit(limit: SessionUsageLimit | false | undefined): SessionUsageLimit | undefined {
  return limit === false ? () => false : limit;
}
