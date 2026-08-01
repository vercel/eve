import type { PublicAgentDefinition } from "#shared/agent-definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { RemoteAgentDefinition } from "#public/definitions/remote-agent.js";
import { defineDynamic as defineDynamicBase } from "#public/definitions/tool.js";
import type {
  DynamicEvents,
  DynamicEventsWithFallback,
  DynamicSentinel,
} from "#shared/dynamic-tool-definition.js";

declare const DEFINED_AGENT: unique symbol;

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

/** Literal-preserving value returned by {@link defineAgent}. */
export type DefinedAgent<TAgent extends AgentDefinition = AgentDefinition> = TAgent & {
  readonly [DEFINED_AGENT]: true;
};

/**
 * Agent configuration returned by a dynamic subagent resolver. The description
 * tells the parent agent when to delegate.
 */
export type DynamicLocalSubagentDefinition = AgentDefinition & {
  readonly description: string;
};

/** Definition a dynamic subagent resolver may select at runtime. */
export type DynamicSubagentDefinition = DynamicLocalSubagentDefinition | RemoteAgentDefinition;

type DynamicEventHandler<TEvents extends DynamicEvents> = Extract<
  NonNullable<TEvents[keyof TEvents]>,
  (...args: never[]) => unknown
>;
type DynamicEventResult<TEvents extends DynamicEvents> = Awaited<
  ReturnType<DynamicEventHandler<TEvents>>
>;
type DynamicSubagentDescriptionConstraint<TEvents extends DynamicEvents> =
  Exclude<
    Extract<DynamicEventResult<TEvents>, DefinedAgent>,
    DynamicLocalSubagentDefinition
  > extends never
    ? unknown
    : { readonly "Dynamic subagent definitions require a description": never };

/**
 * Defines dynamic agent configuration. A returned subagent requires a
 * description so its parent knows when to delegate.
 */
export const defineDynamic: {
  <const TEvents extends DynamicEventsWithFallback, TFallback = unknown>(
    definition: {
      readonly fallback: TFallback;
      readonly events: TEvents;
    } & DynamicSubagentDescriptionConstraint<TEvents>,
  ): DynamicSentinel<Exclude<DynamicEventResult<TEvents>, undefined>, TFallback>;
  <const TEvents extends DynamicEvents>(
    definition: {
      readonly events: TEvents;
    } & DynamicSubagentDescriptionConstraint<TEvents>,
  ): DynamicSentinel<DynamicEventResult<TEvents>>;
} = defineDynamicBase;

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
): DefinedAgent<TAgent>;
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}
