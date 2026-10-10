import {
  defineAgent,
  defineDynamic,
  type AgentReasoningDefinition,
  type AgentStaticModelDefinition,
} from "eve";

import { DEFAULT_AGENT_MODEL_ID, DEFAULT_AGENT_REASONING } from "#shared/default-agent-model.js";
import { getLocalDevCapability } from "eve/local-dev";

import selfModification from "../../extension.js";
import { resolveSelfModificationConfig, type SelfModificationConfig } from "../../../config.js";
import { isLocalSelfModificationEnabled } from "../../../mode.js";
import {
  followUpDelegation,
  namedInstallationDelegation,
  persistenceDelegation,
  renderDescription,
  repairDelegation,
  sourceDelegation,
} from "../../../subagent-guidance.js";

/** Fallback model when neither the self-modification agent nor its parent configures one. */
export const FALLBACK_SELF_MODIFICATION_MODEL = DEFAULT_AGENT_MODEL_ID;

/** Configuration for the self-modification subagent. */
export interface SelfModificationAgentOptions {
  /** Policy shared with the sandbox and extension mount. */
  readonly config?: SelfModificationConfig;
  /** Model used by the self-modification subagent; defaults to the effective parent model. */
  readonly model?: AgentStaticModelDefinition;
  /**
   * Reasoning effort used by the self-modification subagent.
   */
  readonly reasoning?: AgentReasoningDefinition;
}

const localIntegrationDelegation =
  "Delegate questions about which integrations, channels, connections, or capabilities are available to add: the subagent searches the eve registry and reports exact item addresses instead of guessing them.";

const localTraceDelegation =
  "Delegate requests to investigate, diagnose, or optimize the agent's behavior from local traces to this subagent: it can inspect the invoking session's trace and make persistent source changes when warranted.";

const localEffectiveEdits =
  "Source edits do not affect the caller’s current turn. After this subagent reports changes, do not invoke edited tools or attempt runtime verification until a new user turn.";

/** Defines the local development self-modification dynamic subagent. */
export function defineSelfModificationAgent(options: SelfModificationAgentOptions = {}) {
  const resolve = async (effectiveModel: string | null) => {
    const bound = selfModification.config;
    const config = resolveSelfModificationConfig(options.config ?? bound);
    if (!isLocalSelfModificationEnabled(config) || getLocalDevCapability() === undefined) {
      return null;
    }
    const configuredModel = options.model ?? bound.model ?? effectiveModel ?? undefined;
    const reasoning =
      options.reasoning ??
      bound.reasoning ??
      (configuredModel === undefined ? DEFAULT_AGENT_REASONING : undefined);
    const model = configuredModel ?? FALLBACK_SELF_MODIFICATION_MODEL;
    const description = renderDescription([
      "Delegate here immediately when the user asks to change the self-modification subagent's model, reasoning, or configuration. Also delegate when the user asks to change this eve agent or its authored source.",
      sourceDelegation,
      persistenceDelegation,
      namedInstallationDelegation,
      localIntegrationDelegation,
      localTraceDelegation,
      followUpDelegation,
      repairDelegation,
      localEffectiveEdits,
    ]);
    return defineAgent({ description, model, reasoning });
  };

  return defineDynamic<string | null>({ select: (view) => view.model?.id ?? null, resolve });
}

export default defineSelfModificationAgent();
