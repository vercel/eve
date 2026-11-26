import { type ModelCompactionInput, modelCompaction } from "#shared/compaction-strategy.js";
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

export interface AgentContents {
  readonly model: readonly Definition[];
  readonly instructions: readonly Definition[];
  readonly connections: readonly Definition[];
  readonly tools: readonly Definition[];
  readonly skills: readonly Definition[];
  readonly files: {
    readonly hooks: readonly Definition[];
    readonly dynamicSubagents: readonly Definition[];
    readonly memory: readonly Definition[];
    readonly scheduleTools: readonly Definition[];
  };
}

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

export interface AgentSettingsFields {
  readonly compactionStrategy?: ModelCompactionInput<never>;
  readonly compactionModel?: RuntimeModelReference;
  readonly compactionThresholdPercent?: number;
  readonly sessionTimeoutMs?: number | false;
  readonly sessionUsage?: () => SessionUsageLimit | false | undefined;
  readonly modelCallsPerStep?: number;
  readonly reasoning?: AgentReasoningDefinition;
  readonly retention?: AgentWorkflowRetentionDefinition;
}

export function settingsOf(fields: AgentSettingsFields): SessionAgentSettings {
  let sessionUsage: { readonly limit: SessionUsageLimit | undefined } | undefined;
  return {
    compaction: {
      strategy:
        fields.compactionStrategy === undefined
          ? undefined
          : modelCompaction(fields.compactionStrategy, "compactionStrategy"),
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
