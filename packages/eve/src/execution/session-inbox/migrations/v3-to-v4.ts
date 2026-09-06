import type { Migration, Wire } from "#execution/session-inbox/migration.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";

type PayloadV3 = Extract<Wire<3>, { kind: "deliver" }>["payload"];
type PayloadV4 = Extract<Wire<4>, { kind: "deliver" }>["payload"];

export const v3ToV4 = {
  from: 3,
  to: 4,
  up(wire) {
    if (wire.kind !== "deliver") return { ...wire, version: 4 };
    return { ...wire, payload: up(wire.payload), payloads: wire.payloads.map(up), version: 4 };
  },
  down(wire) {
    if (wire.kind !== "deliver") return { ...wire, version: 3 };
    return { ...wire, payload: down(wire.payload), payloads: wire.payloads.map(down), version: 3 };
  },
} satisfies Migration<3, 4>;

function up(payload: PayloadV3): PayloadV4 {
  if (payload.task === undefined) return { ...payload, task: undefined };
  const { inputRequests, ...task } = payload.task;
  return {
    ...payload,
    task: {
      ...task,
      inputRequests: inputRequests?.flatMap(({ taskId, hookPayload }) =>
        hookPayload.event.requests.map((request) => ({
          taskId,
          hookPayload,
          replyTo: hookPayload.childContinuationToken,
          request,
          sequence: hookPayload.event.sequence,
          stepIndex: hookPayload.event.stepIndex,
          turnId: hookPayload.event.turnId,
        })),
      ),
      views: task.views?.map((view) => ({
        ...view,
        executor:
          view.executor?.binding === undefined ? undefined : { binding: view.executor.binding },
      })),
    },
  };
}

function down(payload: PayloadV4): PayloadV3 {
  if (payload.task === undefined) return { ...payload, task: undefined };
  const { agentRequests, inputRequests, ...task } = payload.task;
  if (agentRequests !== undefined || inputRequests !== undefined) {
    // Old parents have neither an agent-request handler nor the new answer route.
    throw new SessionInboxWireError(
      "Cannot encode task agent or input requests for wire version 3.",
    );
  }
  return { ...payload, task };
}
