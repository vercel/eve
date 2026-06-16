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

export const sessionProvider: FrameworkContextProvider<Session> = {
  key: SessionKey,
  create(ctx, session) {
    const currentAuth = ctx.require(AuthKey);
    const emission = getHarnessEmissionState(session.state);
    const turnId = emission.turnId.length > 0 ? emission.turnId : `turn_${emission.sequence}`;

    return {
      value: Object.freeze({
        auth: {
          current: currentAuth,
          initiator: ctx.get(InitiatorAuthKey) ?? currentAuth,
        },
        parent: ctx.get(ParentSessionKey),
        sessionId: ctx.require(SessionIdKey),
        turn: { id: turnId, sequence: emission.sequence },
      }),
    };
  },
};
