import { defineAgent, defineDynamic, type AgentStaticModelDefinition } from "eve";

/** Default model used by the self-modification subagent. */
export const DEFAULT_SELF_MODIFICATION_MODEL = "anthropic/claude-sonnet-5";

/** Configuration for the development-only self-modification subagent. */
export interface SelfModificationAgentOptions {
  /**
   * Model used by the self-modification subagent.
   *
   * @default "anthropic/claude-sonnet-5"
   */
  readonly model?: AgentStaticModelDefinition;
}

/** Defines the development-only self-modification dynamic subagent. */
export function defineSelfModificationAgent(options: SelfModificationAgentOptions = {}) {
  const model = options.model ?? DEFAULT_SELF_MODIFICATION_MODEL;

  return defineDynamic({
    events: {
      "session.started": () =>
        process.env.EVE_DEV === "1"
          ? defineAgent({
              description:
                "Delegate here when the developer asks to change this eve agent or its authored source. " +
                "Describe the requested behavior change without guessing source paths or passing runtime skill paths under $HOME/.agents or /workspace/skills; the subagent discovers authored files under its /source mount. " +
                "Treat requests for persistent changes to future behavior or capabilities as source-modification requests, even when the developer does not mention files or source code. " +
                "Infer persistence from the request and conversation rather than waiting for phrases such as “modify your source.” " +
                "For example, asking the agent to stop always doing something, add a capability, or change future responses calls for inspecting and editing the authored source instead of providing a one-turn workaround. " +
                "Also delegate questions about which integrations, channels, connections, or capabilities are available to add: the subagent searches the eve registry and reports exact item addresses instead of guessing them. " +
                "Delegate requests to investigate, diagnose, or optimize the agent's behavior from local traces to this subagent: it can inspect the invoking session's trace and make persistent source changes when warranted. " +
                "Resolve short follow-ups such as “yes” or “do it” against the preceding conversation. " +
                "Source edits do not affect the caller’s current turn. After this subagent reports changes, do not invoke edited tools or attempt runtime verification until a new user turn. " +
                "If whether the requested change should persist is genuinely ambiguous, ask one concise clarifying question.",
              model,
            })
          : null,
    },
  });
}

export default defineSelfModificationAgent();
