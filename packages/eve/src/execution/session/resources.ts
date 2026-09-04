type Id<Kind extends string> = string & { readonly __kind: Kind };

export type SessionId = Id<"session">;
export type WorkflowRunId = Id<"workflow-run">;
export type EventStreamId = Id<"event-stream">;
export type SnapshotStreamId = Id<"snapshot-stream">;
export type SnapshotRecordId = Id<"snapshot-record">;

export interface EventStreamRef {
  readonly id: EventStreamId;
}

export interface SnapshotStreamRef {
  readonly id: SnapshotStreamId;
}

export interface SnapshotRecordRef {
  readonly id: SnapshotRecordId;
}

export interface SessionResources {
  readonly sessionId: SessionId;
  readonly holderRunId: WorkflowRunId;
  readonly events: EventStreamRef;
  readonly snapshots: SnapshotStreamRef;
  readonly control: {
    readonly token: string;
    readonly ownerRunId: WorkflowRunId;
  };
  readonly initialEventId: string;
}

export function createSessionResources(
  holderRunId: string,
  initialEventId: string,
): SessionResources {
  return {
    sessionId: holderRunId as SessionId,
    holderRunId: holderRunId as WorkflowRunId,
    events: { id: encodeStreamLocation({ runId: holderRunId }) as EventStreamId },
    snapshots: {
      id: encodeStreamLocation({
        runId: holderRunId,
        namespace: "eve.session.snapshots",
      }) as SnapshotStreamId,
    },
    control: { token: `eve:holder:${holderRunId}`, ownerRunId: holderRunId as WorkflowRunId },
    initialEventId,
  };
}
import { encodeStreamLocation } from "#execution/session/stream-location.js";
