import type { ChannelAdapter } from "#channel/adapter.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  SandboxKey,
  type Session,
  SessionKey,
  type SessionParent,
  type SessionTurn,
} from "#context/keys.js";
import { setChannelContext } from "#execution/channel-context.js";
import type { SandboxAccess } from "#sandbox/state.js";

export interface ActiveSessionInit {
  readonly sessionId: string;
  readonly turn: SessionTurn;
  readonly parent?: SessionParent;
  readonly sandbox?: SandboxAccess;
  readonly channel?: ChannelAdapter;
}

export function buildActiveSessionContext(init: ActiveSessionInit): ContextContainer {
  const ctx = new ContextContainer();

  const session: Session = buildSession(init);
  ctx.set(SessionKey, session);

  if (init.sandbox !== undefined) {
    ctx.set(SandboxKey, init.sandbox);
  }

  if (init.channel !== undefined) {
    setChannelContext(ctx, init.channel);
  }

  return ctx;
}

function buildSession(init: ActiveSessionInit): Session {
  if (init.parent === undefined) {
    return {
      auth: { current: null, initiator: null },
      sessionId: init.sessionId,
      turn: init.turn,
    };
  }

  return {
    auth: { current: null, initiator: null },
    parent: init.parent,
    sessionId: init.sessionId,
    turn: init.turn,
  };
}

export async function runWithActiveSessionContext<T>(
  init: ActiveSessionInit,
  fn: () => Promise<T> | T,
): Promise<T> {
  const ctx = buildActiveSessionContext(init);
  return await contextStorage.run(ctx, async () => await fn());
}
