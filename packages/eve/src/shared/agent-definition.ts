import type { LanguageModel } from "ai";
import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import type { JsonObject } from "#shared/json.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/**
 * Optional overrides that eve forwards to the AI SDK model runtime call for
 * this model.
 */
export interface AgentModelOptionsDefinition {
  readonly providerOptions?: Record<string, JsonObject>;
}

/**
 * How an agent's model is reached at runtime, decided at compile time from the
 * authored model value.
 *
 * - `gateway`: routed through the Vercel AI Gateway. This covers a bare model
 *   id string (resolved via the AI SDK global default provider), a
 *   `gateway(...)` instance, and a gateway id whose provider key is forwarded
 *   to the gateway via `providerOptions.gateway.byok`. `target` is the upstream
 *   provider slug carried in the model id (e.g. `"anthropic"`), best-effort.
 *   `byok` is set to that provider slug when a `providerOptions.gateway.byok`
 *   block is present.
 * - `external`: a direct provider instance (e.g. `anthropic(...)`) that bypasses
 *   the gateway and talks to the provider's own endpoint. `provider` is the AI
 *   SDK provider name (e.g. `"anthropic"`).
 *
 * This is a routing fact, not a model-existence check; it does not assert the
 * model id names a real model.
 */
export type ModelRouting =
  | { kind: "gateway"; target: string; byok?: string }
  | { kind: "external"; provider: string };

export type InternalAgentModelDefinition = {
  id: string;
  contextWindowTokens?: number;
  source?: ModuleSourceRef;
  providerOptions?: Record<string, JsonObject>;
};

/**
 * The model handle you assign to an agent's `model` field. This is the AI SDK
 * `LanguageModel` value (for example, the result of a provider or gateway
 * model call), not an eve-authored definition object.
 */
export type PublicAgentModelDefinition = LanguageModel;

export interface InternalAgentCompactionDefinition {
  /**
   * Optional model used only for generating compaction summaries.
   *
   * When omitted, eve uses the active turn model for the summary call.
   */
  model?: InternalAgentModelDefinition;
  /**
   * Fraction of the primary model context window that triggers compaction.
   *
   * eve defaults to `0.9` when this is omitted.
   */
  thresholdPercent?: number;
}

/**
 * Configures conversation compaction: when the model context window fills past
 * `thresholdPercent`, eve summarizes earlier turns to reclaim space. Every
 * field is optional; omit the block to use eve's defaults.
 */
export interface PublicAgentCompactionDefinition {
  /**
   * Optional override for the compaction summary model's context window size,
   * in tokens.
   *
   * Same escape hatch as the agent-level `modelContextWindowTokens`. When set,
   * eve uses this value verbatim and skips the AI Gateway lookup for the
   * compaction summary model.
   */
  readonly modelContextWindowTokens?: number;
  /**
   * Optional model used only for generating compaction summaries.
   *
   * When omitted, eve uses the active turn model for the summary call.
   */
  readonly model?: PublicAgentModelDefinition;
  /**
   * Fraction of the primary model context window that triggers compaction.
   *
   * eve defaults to `0.9` when this is omitted.
   */
  readonly thresholdPercent?: number;
}

/**
 * Experimental, opt-in agent capabilities authored in `agent.ts`.
 *
 * These options are unstable and may change or be removed in any release.
 * Each agent (the root agent and every subagent) carries its own flags, so
 * code mode can be enabled for the whole graph, only a subagent, or only
 * the parent.
 */
export interface AgentExperimentalDefinition {
  /**
   * Routes executable tools through a sandboxed code-execution wrapper
   * instead of exposing them directly to the model. The model writes
   * JavaScript that calls the tools inside the sandbox.
   *
   * When unset, eve falls back to the `EVE_EXPERIMENTAL_CODE_MODE`
   * environment variable (`"1"` enables it) for backwards compatibility.
   */
  readonly codeMode?: boolean;
}

/**
 * Advanced hosted-build controls authored in `agent.ts`.
 *
 * These affect packaging and bundling only. They do not affect the runtime
 * prompt or authored execution APIs.
 */
export interface AgentBuildDefinition {
  /**
   * Additional imported package names that eve should keep external and trace
   * into hosted build output. eve also keeps matching imports external while
   * compiling authored TypeScript modules such as tools, channels, and
   * schedules.
   *
   * Prefer this when a package is sensitive to bundling and should ship via
   * `server/node_modules` in hosted output.
   */
  readonly externalDependencies?: string[];
}

/**
 * Compiled-side agent definition. Carries a `name` because the compiler
 * stamps the path-derived `agentId` onto every compiled agent node.
 */
export type InternalAgentDefinition = {
  name: string;
  description?: string;
  build?: AgentBuildDefinition;
  compaction?: InternalAgentCompactionDefinition;
  experimental?: AgentExperimentalDefinition;
  model: InternalAgentModelDefinition;
  outputSchema?: JsonObject;
  source?: ModuleSourceRef;
};

/**
 * Shared public definition for an agent.
 *
 * Identity is derived at compile time from `manifest.agentId` (the
 * package name or app-root basename). Authored definitions do not carry
 * a `name` field.
 */
export type PublicAgentDefinition = {
  /**
   * Human-readable description of the agent's purpose. Required for
   * subagents (authored under `subagents/<id>/agent.ts`): surfaced to
   * the parent agent as the lowered subagent tool's description.
   */
  readonly description?: string;
  readonly build?: AgentBuildDefinition;
  readonly compaction?: PublicAgentCompactionDefinition;
  /**
   * Experimental, opt-in capabilities. Unstable, see
   * {@link AgentExperimentalDefinition}.
   */
  readonly experimental?: AgentExperimentalDefinition;
  /**
   * Language model used for agent turns. Accepts an AI Gateway model ID or any
   * AI SDK-compatible language model.
   */
  readonly model: PublicAgentModelDefinition;
  /**
   * Optional override for the primary model's context window size, in tokens.
   *
   * Escape hatch for cases where eve cannot resolve the model's metadata via
   * the AI Gateway model catalog (e.g. a custom or unlisted model id). When
   * set, eve uses this value verbatim and skips the AI Gateway lookup. Prefer
   * leaving this unset so eve can stay in sync with provider metadata.
   */
  readonly modelContextWindowTokens?: number;
  readonly modelOptions?: AgentModelOptionsDefinition;
  /**
   * Optional structured return type used when this agent runs in task mode
   * (for example as a subagent, schedule, or remote job). Interactive
   * conversation turns ignore this field unless the client supplies a
   * per-message output schema.
   */
  readonly outputSchema?: StandardJSONSchemaV1<unknown, unknown> | JsonObject;
};
