import type { Session } from "#context/keys.js";
import type { ProgressWorkIdentityV1, ProgressWorkKind } from "#protocol/progress.js";

export function rootProgressWork(session: Session): ProgressWorkIdentityV1 {
  return {
    id: `root:${session.sessionId}:${session.turn.id}`,
    kind: "root-turn",
    rootSessionId: session.sessionId,
    rootTurnId: session.turn.id,
    sessionId: session.sessionId,
    turnId: session.turn.id,
  };
}

export function childProgressWork(input: {
  readonly callId: string;
  readonly kind: Exclude<ProgressWorkKind, "root-turn">;
  readonly name: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly parentWork: ProgressWorkIdentityV1;
}): ProgressWorkIdentityV1 {
  return {
    callId: input.callId,
    id: `work:${input.parentSessionId}:${input.parentTurnId}:${input.callId}`,
    kind: input.kind,
    name: input.name,
    parentId: input.parentWork.id,
    rootSessionId: input.parentWork.rootSessionId,
    rootTurnId: input.parentWork.rootTurnId,
  };
}
