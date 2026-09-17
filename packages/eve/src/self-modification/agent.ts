import type { DynamicResolveContext } from "#dynamic/definition.js";
import {
  defineAgent,
  defineDynamic,
  type AgentReasoningDefinition,
  type AgentStaticModelDefinition,
  type DynamicSentinel,
  type DynamicSubagentDefinition,
} from "#public/index.js";

import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

import { resolveSelfModificationConfig, type SelfModificationConfig } from "./config.js";
import { hasGitHubCredential } from "./credentials.js";
import { resolveSelfModificationMode } from "./mode.js";

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

function renderDescription(sections: readonly string[]): string {
  return sections.filter((section) => section.length > 0).join(" ");
}

const sourceDelegation =
  "If the requested change references a tool or skill, include the exact identifier. " +
  "Do not infer source paths; let the child resolve the appropriate file under /source. " +
  "Delegate the requested change and existing constraints without adding unrequested features, implementation steps, or reporting requirements.";

const persistenceDelegation =
  "Treat requests for persistent changes to future behavior or capabilities as source-modification requests, even when the requester does not mention files or source code. " +
  "Infer persistence from the request and conversation rather than waiting for phrases such as “modify your source.” " +
  "For example, asking the agent to stop always doing something, add a capability, or change future responses calls for inspecting and editing the authored source instead of providing a one-turn workaround.";

const namedInstallationDelegation =
  "Treat questions phrased as whether you can install, add, enable, or connect to a named product or service as requests to extend this eve agent and delegate immediately. Do not assume they refer to device software, ask what kind of installation they mean, or deny them because you lack access to the user's device. The subagent determines whether the request maps to an integration, channel, connection, or other capability, then checks registry availability and any required setup.";

const followUpDelegation =
  "Resolve short follow-ups such as “yes” or “do it” against the preceding conversation. " +
  "If whether the requested change should persist is genuinely ambiguous, ask one concise clarifying question.";

const repairDelegation =
  "If a tool or capability created or changed by this subagent later fails or behaves incorrectly, explain the observed problem and offer to delegate a repair. " +
  "Do not start the repair until the user confirms. Treat that confirmation as a source-modification request and delegate it immediately, including the exact identifier, failing behavior, expected behavior, and existing constraints.";

const localIntegrationDelegation =
  "Delegate questions about which integrations, channels, connections, or capabilities are available to add: the subagent searches the eve registry and reports exact item addresses instead of guessing them.";

const deployedIntegrationDelegation =
  "Delegate requests to add integrations, channels, connections, or capabilities: the subagent searches the official eve registry and can install source changes into the draft proposal. Setup may require non-secret answers or an external action, and secret binding remains separate.";

const localTraceDelegation =
  "Delegate requests to investigate, diagnose, or optimize the agent's behavior from local traces to this subagent: it can inspect the invoking session's trace and make persistent source changes when warranted.";

const localEffectiveEdits =
  "Source edits do not affect the caller’s current turn. After this subagent reports changes, do not invoke edited tools or attempt runtime verification until a new user turn.";
const deployedEffectiveEdits =
  "Source edits do not affect the caller’s current turn. The subagent can publish only a draft pull request, and changes become effective only after review, merge, and redeployment.";

/** Defines the environment-aware self-modification dynamic subagent. */
export function defineSelfModificationAgent(
  options: SelfModificationAgentOptions = {},
): DynamicSentinel<DynamicSubagentDefinition | null> {
  const reasoning = options.reasoning;
  const config = resolveSelfModificationConfig(options.config);

  const resolve = async (_event: unknown, ctx: DynamicResolveContext) => {
    const mode = resolveSelfModificationMode(config);
    const model = options.model ?? ctx.model?.id ?? FALLBACK_SELF_MODIFICATION_MODEL;
    const description = renderDescription([
      "Delegate here when the user asks to change this eve agent or its authored source.",
      sourceDelegation,
      persistenceDelegation,
      namedInstallationDelegation,
      mode === "local" ? localIntegrationDelegation : deployedIntegrationDelegation,
      mode === "local" ? localTraceDelegation : "",
      followUpDelegation,
      repairDelegation,
      mode === "local" ? localEffectiveEdits : deployedEffectiveEdits,
    ]);
    if (mode === "local") return defineAgent({ description, model, reasoning });
    if (mode !== "deployed" || config.deployed === undefined) return null;
    if (config.deployed.credentials.kind === "pat" && !hasGitHubCredential()) return null;
    try {
      if (
        !(await config.deployed.authorize({
          channel: ctx.channel,
          principal: ctx.session.auth.current,
        }))
      ) {
        return null;
      }
    } catch {
      return null;
    }
    return defineAgent({ description, model, reasoning });
  };

  return defineDynamic({
    events: {
      "session.started": resolve,
      "turn.started": resolve,
    },
  });
}

export default defineSelfModificationAgent();
