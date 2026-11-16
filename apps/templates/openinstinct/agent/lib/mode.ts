import type { DynamicContext } from "eve";
import { defineInstructions } from "eve/instructions";

interface AgentModeContext {
  readonly session: {
    readonly auth: Pick<
      DynamicContext["session"]["auth"],
      "current" | "initiator"
    >;
  };
}

function agentMode(authenticator: string | undefined) {
  if (authenticator === "scheduled-worker") return "scheduled-worker" as const;
  if (authenticator === "scheduled-result") return "scheduled-report" as const;
  return "interactive" as const;
}

type AgentMode = ReturnType<typeof agentMode>;

function sessionAgentMode(auth: AgentModeContext["session"]["auth"]) {
  if (auth.initiator?.authenticator === "scheduled-worker") {
    return "scheduled-worker" as const;
  }
  const caller = auth.current ?? auth.initiator;
  return agentMode(caller?.authenticator);
}

export function resolveModeValue<
  const V extends Partial<Record<AgentMode, unknown>>,
>(context: AgentModeContext, valueByMode: V): V[keyof V] | null {
  const value = valueByMode[sessionAgentMode(context.session.auth)];
  if (value === undefined) return null;
  // SAFETY: `value` was read from `valueByMode` under one of its own keys, so it
  // is one of V's property values.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Indexing a generic record by a key union cannot narrow to V[keyof V].
  return value as V[keyof V];
}

export function resolveModeInstructions(
  context: DynamicContext,
  contentByMode: Partial<Record<AgentMode, string>>
) {
  const content = resolveModeValue(context, contentByMode);
  return content == null ? null : defineInstructions({ content });
}
