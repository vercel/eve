import type { ProgressContextV1 } from "#channel/types.js";
import type { Session } from "#context/keys.js";
import {
  deriveChildActivityWorkId,
  deriveRootTurnActivityWorkId,
} from "#execution/activity-work-id.js";
import type { ActivityWorkIdentityV1, ActivityWorkKind } from "#protocol/activity.js";

export function deriveRootTurnWorkIdentity(session: Session): ActivityWorkIdentityV1 {
  return {
    id: deriveRootTurnActivityWorkId({
      sessionId: session.sessionId,
      turnId: session.turn.id,
    }),
    kind: "root-turn",
    rootSessionId: session.sessionId,
    rootTurnId: session.turn.id,
    sessionId: session.sessionId,
    turnId: session.turn.id,
  };
}

export function childProgressContext(input: {
  readonly callId: string;
  readonly kind: Exclude<ActivityWorkKind, "root-turn">;
  readonly name: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly progress: ProgressContextV1 | undefined;
}): ProgressContextV1 | undefined {
  if (input.progress?.workIdentity === undefined) return undefined;
  return {
    callback: input.progress.callback,
    workIdentity: deriveChildWorkIdentity({ ...input, parentWork: input.progress.workIdentity }),
  };
}

export function deriveChildWorkIdentity(input: {
  readonly callId: string;
  readonly kind: Exclude<ActivityWorkKind, "root-turn">;
  readonly name: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly parentWork: ActivityWorkIdentityV1;
}): ActivityWorkIdentityV1 {
  return {
    callId: input.callId,
    id: deriveChildActivityWorkId(input),
    kind: input.kind,
    name: input.name,
    parentId: input.parentWork.id,
    rootSessionId: input.parentWork.rootSessionId,
    rootTurnId: input.parentWork.rootTurnId,
  };
}
