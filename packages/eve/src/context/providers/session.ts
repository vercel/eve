import {
  AuthKey,
  InitiatorAuthKey,
  ParentSessionKey,
  type Session,
  SessionIdKey,
  SessionKey,
} from "#context/keys.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import type { ContextContainer } from "#context/container.js";
import type { HarnessSession } from "#harness/types.js";

export function createSessionContext(ctx: ContextContainer, session: HarnessSession): Session {
  const currentAuth = ctx.require(AuthKey);
  const emission = getHarnessEmissionState(session.state);
  const turnId = emission.turnId.length > 0 ? emission.turnId : `turn_${emission.sequence}`;

  return Object.freeze({
    auth: {
      current: currentAuth,
      initiator: ctx.get(InitiatorAuthKey) ?? currentAuth,
    },
    parent: ctx.get(ParentSessionKey),
    sessionId: ctx.require(SessionIdKey),
    turn: { id: turnId, sequence: emission.sequence },
  });
}

export const sessionProvider: FrameworkContextProvider<Session> = {
  key: SessionKey,
  create(ctx, session) {
    return {
      value: createSessionContext(ctx, session),
    };
  },
};
