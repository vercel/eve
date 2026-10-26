import type { SessionFrame } from "#dynamic/definition.js";
import type { ContextReader } from "#context/key.js";
import { SessionIdKey } from "#context/keys.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";
import type { JsonValue } from "#shared/json.js";
import { sessionFrameOf } from "./frame.js";
import { effectiveModelId } from "./kinds/model.js";
import { readReactionsState } from "./state.js";

/**
 * What eve keeps with a dynamic remote agent's child, privately, so it can build the agent's
 * credentials again wherever it reaches the child: the session as it was when the child opened,
 * and the memo results the remote agent was built from. The steps that message, reset, and
 * cancel the child, and the route that follows its stream, all build them from it, never from
 * whoever is calling now.
 */
export interface DynamicRemoteBinding {
  readonly session: SessionFrame["session"];
  readonly channel: SessionFrame["channel"];
  readonly conversation?: SessionFrame["conversation"];
  /** The model the parent had chosen, as `ctx.model.id`. */
  readonly model?: string;
  /** When the parent's latest commit was written, as `ctx.now`. */
  readonly at: string;
  /** The parent's stream position: `ctx.view` and `ctx.turn` fold up to it. */
  readonly position: number;
  /** The memo results the definition used, by key digest. */
  readonly memos: Readonly<Record<string, JsonValue>>;
}

/** The binding a child opened now keeps: the session as of its latest commit. */
export function bindingOf(ctx: ContextReader, nodeId: string): DynamicRemoteBinding {
  const state = readReactionsState(ctx);
  const frame = sessionFrameOf(ctx);
  const model = effectiveModelId(ctx);
  return {
    at: frame.now.toISOString(),
    channel: structuredClone(frame.channel),
    ...(frame.conversation !== undefined && {
      conversation: structuredClone(frame.conversation),
    }),
    memos: state.memos?.[`subagent:${nodeId}`] ?? {},
    ...(model !== undefined && { model }),
    position: Math.max(0, sessionTables(frame.view).position - 1),
    session: {
      auth: structuredClone(frame.session.auth),
      id: ctx.get(SessionIdKey) ?? frame.session.id,
      ...(frame.session.parent !== undefined && { parent: structuredClone(frame.session.parent) }),
      ...(frame.session.predecessor !== undefined && {
        predecessor: structuredClone(frame.session.predecessor),
      }),
      ...(frame.session.schedule !== undefined && {
        schedule: structuredClone(frame.session.schedule),
      }),
    },
  };
}
