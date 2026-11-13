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
import { instructions as eveInstructions, workspace } from "./instructions.js";
import { parentModel } from "./model.js";
import { skills as eveSkills } from "./skills.js";
import { staticTools } from "./tools.js";

// One path from an agent's contents to the definitions its sessions run. An agent compiled from an
// `agent/` directory maps its node's files to them (`#definitions/compiled-agent.js`). Each field
// arrives as the definitions its builder made; this module owns where each goes, and what the
// agent's settings are.

/** An agent's contents: each kind of file in `agent/`, as the definitions its builder made. */
export interface AgentContents {
  /** The model, as `agent.ts` chooses it. The last choice wins. */
  readonly model: readonly Definition[];
  /** Instructions chosen per session: `agent/instructions/*`. */
  readonly instructions: readonly Definition[];
  /** `agent/connections/*`. */
  readonly connections: readonly Definition[];
  /** `agent/tools/*`. */
  readonly tools: readonly Definition[];
  /** `agent/skills/*`. */
  readonly skills: readonly Definition[];
  /** What else an `agent/` directory declares, at the positions its files take. */
  readonly files: {
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
 *   files, its declared subagents and eve's defaults among them) come before dynamic ones, and
 *   connections keep theirs before tools check names against them.
 * - eve's skills listing, approvals, builtins and catalog come after everything the agent
 *   declares, so they see all of it: the catalog indexes the final tool table.
 * - The last model choice wins, and a parent's choice comes last, so it's the one the session runs.
 */
export function agentDefinitionsOf(contents: AgentContents): readonly Definition[] {
  const { files } = contents;
  return [
    ...files.hooks,
    ...contents.model,
    eveInstructions,
    ...contents.instructions,
    workspace,
    eveConnections,
    ...contents.connections,
    staticTools,
    ...files.dynamicSubagents,
    ...files.memory,
    ...contents.tools,
    ...files.scheduleTools,
    ...contents.skills,
    eveSkills,
    approvals,
    builtins,
    catalog,
    parentModel,
  ];
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
