import {
  AuthKey,
  InitiatorAuthKey,
  ParentSessionKey,
  type Session,
  SessionIdKey,
  SessionKey,
  SessionPredecessorKey,
  SteeredByKey,
} from "#context/keys.js";
import type { ContextReader } from "#context/key.js";
import type { HarnessSession } from "#harness/types.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { activeTurnId, turnPosition } from "#harness/session-machine/view.js";
import { projectionFor } from "#harness/session-machine/current.js";

export const sessionProvider = {
  key: SessionKey,
  create(ctx: ContextReader, session: Pick<HarnessSession, "state">) {
    const currentAuth = ctx.require(AuthKey);
    const steeredBy = ctx.get(SteeredByKey);
    const emission = turnPosition(projectionFor(ctx, session.state));
    const turnId = activeTurnId(emission);

    return {
      value: Object.freeze({
        auth: {
          current: currentAuth,
          initiator: ctx.get(InitiatorAuthKey) ?? currentAuth,
          ...(steeredBy !== undefined && steeredBy.length > 0 && { steeredBy }),
        },
        parent: ctx.get(ParentSessionKey),
        predecessor: ctx.get(SessionPredecessorKey),
        sessionId: ctx.require(SessionIdKey),
        turn: { id: turnId, sequence: emission.sequence },
      }),
    };
  },
} satisfies FrameworkContextProvider<Session>;
