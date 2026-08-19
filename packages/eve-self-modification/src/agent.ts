import {
  defineAgent,
  defineDynamic,
  type AgentStaticModelDefinition,
  type DynamicSentinel,
  type DynamicSubagentDefinition,
} from "eve";

/** Fallback model used by the self-modification subagent when no model is configured and the parent agent model cannot be resolved. */
export const FALLBACK_SELF_MODIFICATION_MODEL = "anthropic/claude-sonnet-5";

/** Configuration for the development-only self-modification subagent. */
export interface SelfModificationAgentOptions {
  /**
   * Model used by the self-modification subagent. When unspecified, the parent agent's model is used. If the parent agent's model is unresolved, falls back to "anthropic/claude-sonnet-5".
   */
  readonly model?: AgentStaticModelDefinition;
}

/** Defines the development-only self-modification dynamic subagent. */
export function defineSelfModificationAgent(
  options: SelfModificationAgentOptions = {},
): DynamicSentinel<DynamicSubagentDefinition | null> {
  return defineDynamic({
    events: {
      "session.started": (_event, context) =>
        process.env.EVE_DEV === "1"
          ? defineAgent({
              description:
                "Delegate here when the developer asks to change this eve agent or its authored source. " +
                "Describe the requested behavior change without guessing source paths or passing runtime skill paths under $HOME/.agents or /workspace/skills; the subagent discovers authored files under its /source mount. " +
                "Treat requests for persistent changes to future behavior or capabilities as source-modification requests, even when the developer does not mention files or source code. " +
                "Infer persistence from the request and conversation rather than waiting for phrases such as “modify your source.” " +
                "For example, asking the agent to stop always doing something, add a capability, or change future responses calls for inspecting and editing the authored source instead of providing a one-turn workaround. " +
                "Resolve short follow-ups such as “yes” or “do it” against the preceding conversation. " +
                "Source edits do not affect the caller’s current turn. After this subagent reports changes, do not invoke edited tools or attempt runtime verification until a new user turn. " +
                "If whether the requested change should persist is genuinely ambiguous, ask one concise clarifying question.",
              model: options.model ?? context.model?.id ?? FALLBACK_SELF_MODIFICATION_MODEL,
            })
          : null,
    },
  });
}

export default defineSelfModificationAgent();
