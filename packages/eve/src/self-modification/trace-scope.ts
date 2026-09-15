import type { ToolContext } from "eve/tools";

import { loadContext } from "#context/container.js";
import { ChannelInstrumentationKey } from "#context/keys.js";
import { getAdapterKind } from "#channel/adapter.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

import type { ResolvedDeployedSelfModificationConfig } from "./config.js";

export interface ConversationTraceScope {
  readonly rootSessionId: string;
}

/** Resolves the only conversation a deployed selfmod child may inspect. */
export async function resolveConversationTraceScope(
  deployed: ResolvedDeployedSelfModificationConfig,
  ctx: Pick<ToolContext, "session">,
): Promise<ConversationTraceScope> {
  const rootSessionId = ctx.session.parent?.rootSessionId;
  if (rootSessionId === undefined) throw unavailable();

  try {
    if (
      !(await deployed.authorize({
        channel: currentChannel(),
        principal: ctx.session.auth.current,
      }))
    ) {
      throw unavailable();
    }
  } catch (error) {
    if (error instanceof ConversationTraceUnavailableError) throw error;
    throw unavailable();
  }
  return { rootSessionId };
}

export class ConversationTraceUnavailableError extends Error {
  constructor() {
    super("Conversation traces are unavailable.");
  }
}

export function unavailable(): ConversationTraceUnavailableError {
  return new ConversationTraceUnavailableError();
}

/** Whether self-modification is executing in a hosted Vercel runtime. */
export function hasVercelTraceBackend(): boolean {
  return process.env.VERCEL === "1";
}

function currentChannel(): {
  readonly kind?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
} {
  try {
    const context = loadContext();
    const adapter = context.get(ChannelKey);
    return {
      kind: adapter === undefined ? undefined : getAdapterKind(adapter),
      metadata: context.get(ChannelInstrumentationKey)?.metadata,
    };
  } catch {
    // Direct tool tests do not run in an ALS scope. Production executions do.
    return {};
  }
}
