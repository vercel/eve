import type { ActivityObserverConfig } from "#channel/types.js";
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

export function deriveBackgroundTaskActivityObserver(input: {
  readonly activityObserver: ActivityObserverConfig | undefined;
  readonly callId: string;
  readonly name: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly rootSessionId: string;
}): ActivityObserverConfig | undefined {
  if (input.activityObserver === undefined) return undefined;
  const parentWork = input.activityObserver.workIdentity ?? {
    id: deriveRootTurnActivityWorkId({
      sessionId: input.parentSessionId,
      turnId: input.parentTurnId,
    }),
    kind: "root-turn" as const,
    rootSessionId: input.rootSessionId,
    rootTurnId: input.parentTurnId,
    sessionId: input.parentSessionId,
    turnId: input.parentTurnId,
  };
  return {
    sink: input.activityObserver.sink,
    workIdentity: deriveChildWorkIdentity({ ...input, kind: "task", parentWork }),
  };
}

export function deriveChildActivityObserverConfig(input: {
  readonly callId: string;
  readonly kind: Exclude<ActivityWorkKind, "root-turn">;
  readonly name: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly activityObserver: ActivityObserverConfig | undefined;
}): ActivityObserverConfig | undefined {
  if (input.activityObserver?.workIdentity === undefined) return undefined;
  return {
    sink: input.activityObserver.sink,
    workIdentity: deriveChildWorkIdentity({
      ...input,
      parentWork: input.activityObserver.workIdentity,
    }),
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
