import {
  AuthKey,
  InitiatorAuthKey,
  ParentSessionKey,
  type Session,
  SessionIdKey,
  SessionKey,
} from "#context/keys.js";
import type { ContextContainer } from "#context/container.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { getHarnessEmissionState } from "#harness/emission.js";

export function createSessionContext(input: {
  readonly auth: Session["auth"]["current"];
  readonly ctx: ContextContainer;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly turnSequence?: number;
}): Session {
  const turnSequence = input.turnSequence ?? 0;
  return Object.freeze({
    auth: {
      current: input.auth,
      initiator: input.ctx.get(InitiatorAuthKey) ?? input.auth,
    },
    parent: input.ctx.get(ParentSessionKey),
    sessionId: input.sessionId,
    turn: {
      id: input.turnId ?? `turn_${turnSequence}`,
      sequence: turnSequence,
    },
  });
}

export const sessionProvider: FrameworkContextProvider<Session> = {
  key: SessionKey,
  create(ctx, session) {
    const currentAuth = ctx.require(AuthKey);
    const emission = getHarnessEmissionState(session.state);

    return {
      value: createSessionContext({
        auth: currentAuth,
        ctx,
        sessionId: ctx.require(SessionIdKey),
        turnId: emission.turnId.length > 0 ? emission.turnId : undefined,
        turnSequence: emission.sequence,
      }),
    };
  },
};
