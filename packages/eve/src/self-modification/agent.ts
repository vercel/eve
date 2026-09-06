import { defineAgent, defineDynamic, type AgentStaticModelDefinition } from "#public/index.js";

import { resolveSelfModificationConfig, type SelfModificationConfig } from "./config.js";
import { hasGitHubCredential } from "./credentials.js";
import { resolveSelfModificationMode } from "./mode.js";

/** Default model used by the self-modification subagent. */
export const DEFAULT_SELF_MODIFICATION_MODEL = "anthropic/claude-sonnet-5";

/** Configuration for the self-modification subagent. */
export interface SelfModificationAgentOptions {
  /** Policy shared with the sandbox and extension mount. */
  readonly config?: SelfModificationConfig;
  /**
   * Model used by the self-modification subagent.
   *
   * @default "anthropic/claude-sonnet-5"
   */
  readonly model?: AgentStaticModelDefinition;
}

const localDescription =
  "Delegate here when the developer asks to change this eve agent or its authored source. " +
  "Describe the requested behavior change without guessing source paths or passing runtime skill paths under $HOME/.agents or /workspace/skills; the subagent discovers authored files under its /source mount. " +
  "Treat requests for persistent changes to future behavior or capabilities as source-modification requests, even when the developer does not mention files or source code. " +
  "Infer persistence from the request and conversation rather than waiting for phrases such as “modify your source.” " +
  "For example, asking the agent to stop always doing something, add a capability, or change future responses calls for inspecting and editing the authored source instead of providing a one-turn workaround. " +
  "Also delegate questions about which integrations, channels, connections, or capabilities are available to add: the subagent searches the eve registry and reports exact item addresses instead of guessing them. " +
  "Resolve short follow-ups such as “yes” or “do it” against the preceding conversation. " +
  "Source edits do not affect the caller’s current turn. After this subagent reports changes, do not invoke edited tools or attempt runtime verification until a new user turn. " +
  "If whether the requested change should persist is genuinely ambiguous, ask one concise clarifying question.";

const deployedDescription =
  "Delegate here when the user asks to change this eve agent or its authored source. " +
  "Describe the requested behavior change without guessing source paths or passing runtime skill paths under $HOME/.agents or /workspace/skills; the subagent discovers authored files in an isolated checkout under its /source mount. " +
  "Treat requests for persistent changes to future behavior or capabilities as source-modification requests, even when the user does not mention files or source code. " +
  "Infer persistence from the request and conversation rather than waiting for phrases such as “modify your source.” " +
  "For example, asking the agent to stop always doing something, add a capability, or change future responses calls for inspecting and editing the authored source instead of providing a one-turn workaround. " +
  "Also delegate requests to add integrations, channels, connections, or capabilities: the subagent searches the official eve registry and can install source changes into the draft proposal. Setup may require non-secret answers or an external action, and secret binding remains separate. " +
  "Resolve short follow-ups such as “yes” or “do it” against the preceding conversation. " +
  "Source edits do not affect the caller’s current turn. The subagent can publish only a draft pull request, and changes become effective only after review, merge, and redeployment. " +
  "If whether the requested change should persist is genuinely ambiguous, ask one concise clarifying question.";

/** Defines the environment-aware self-modification dynamic subagent. */
export function defineSelfModificationAgent(options: SelfModificationAgentOptions = {}) {
  const model = options.model ?? DEFAULT_SELF_MODIFICATION_MODEL;
  const config = resolveSelfModificationConfig(options.config);

  const resolve = () => {
    const mode = resolveSelfModificationMode(config);
    if (mode === "local") return defineAgent({ description: localDescription, model });
    if (mode !== "deployed" || config.deployed === undefined) return null;
    if (config.deployed.credentials.kind === "pat" && !hasGitHubCredential()) return null;
    return defineAgent({ description: deployedDescription, model });
  };

  return defineDynamic({
    events: {
      "session.started": resolve,
      "turn.started": resolve,
    },
  });
}

export default defineSelfModificationAgent();
