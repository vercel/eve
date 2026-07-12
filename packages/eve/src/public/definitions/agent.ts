import { DYNAMIC_SENTINEL_KIND } from "#shared/dynamic-tool-definition.js";
import type {
  PublicAgentDefinition,
  PublicAgentStaticSkillVisibilityDefinition,
  StaticSkillVisibilityEvents,
} from "#shared/agent-definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";

export type {
  AgentModelResolveContext,
  AgentModelOptionsDefinition,
  AgentModelResolver,
  AgentReasoningDefinition,
  AgentBuildDefinition,
  PublicAgentDynamicModelDefinition as AgentDynamicModelDefinition,
  PublicAgentDynamicModelResult as AgentDynamicModelResult,
  AgentExperimentalDefinition,
  AgentLimitsDefinition,
  PublicAgentModelSelectionDefinition as AgentModelSelectionDefinition,
  AgentWorkflowDefinition,
  AgentWorkflowWorldDefinition,
  PublicAgentModelDefinition as AgentModelDefinition,
  PublicAgentStaticModelDefinition as AgentStaticModelDefinition,
  PublicAgentCompactionDefinition as AgentCompactionDefinition,
  PublicAgentStaticSkillVisibilityDefinition as AgentStaticSkillVisibilityDefinition,
  StaticSkillVisibilityEvents,
  StaticSkillVisibility,
} from "#shared/agent-definition.js";

/**
 * Additive public agent configuration authored in `agent.ts`.
 *
 * The compiler derives identity at compile time from `manifest.agentId` (the
 * package name or app-root basename), so do not author a `name` field.
 *
 * Declare authentication and network policies on the channel that handles the
 * inbound request, not here. See `eve/channels/auth` for the verifier helpers a
 * channel uses to gate its `fetch` handler.
 */
export type AgentDefinition = PublicAgentDefinition;

/**
 * Defines the agent configuration authored in `agent.ts` and returns it
 * unchanged, preserving its literal type.
 *
 * TypeScript checks the argument against {@link AgentDefinition}: any key outside
 * that shape is a compile error. The compiler derives identity (the agent name)
 * at compile time from `manifest.agentId` (the package name or app-root
 * basename), so do not author a `name` field.
 */
export function defineAgent<TAgent extends AgentDefinition>(
  definition: ExactDefinition<TAgent, AgentDefinition>,
): TAgent {
  return definition;
}

/**
 * Defines the session/turn-only resolver used by `agent.ts` static skill
 * visibility. The dedicated wrapper keeps unsupported lifecycle keys out of
 * the public slot while retaining the `defineDynamic({ events })` shape.
 */
export function defineStaticSkillVisibility<
  const TEvents extends StaticSkillVisibilityEvents,
>(definition: {
  readonly events: ExactDefinition<TEvents, StaticSkillVisibilityEvents>;
}): PublicAgentStaticSkillVisibilityDefinition {
  return {
    events: definition.events,
    kind: DYNAMIC_SENTINEL_KIND,
  };
}
