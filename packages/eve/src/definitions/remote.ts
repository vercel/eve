import type { SessionFrame } from "#dynamic/definition.js";
import type { ContextReader } from "#context/key.js";
import { SessionIdKey } from "#context/keys.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";
import type { JsonValue } from "#shared/json.js";
import { sessionFrameOf } from "./frame.js";
import { effectiveModelId } from "#definitions/model.js";
import { readDefinitionsState } from "./state.js";

export interface DynamicRemoteBinding {
  readonly session: SessionFrame["session"];
  readonly channel: SessionFrame["channel"];
  readonly conversation?: SessionFrame["conversation"];
  readonly model?: string;
  readonly at: string;
  readonly position: number;
  readonly memos: Readonly<Record<string, JsonValue>>;
}

export function bindingOf(ctx: ContextReader, nodeId: string): DynamicRemoteBinding {
  const state = readDefinitionsState(ctx);
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
