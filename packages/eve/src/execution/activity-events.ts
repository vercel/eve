import { normalizeActivityText } from "#execution/activity-text.js";
import { deriveActivityActionId, deriveChildActivityWorkId } from "#execution/activity-work-id.js";
import type { ActivityEventV1, ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { TASK_UPDATE_TOOL_NAME } from "#tools/framework/task-contract.js";

export function projectActivityEvents(input: {
  readonly at: string;
  readonly event: UnstampedMessageStreamEvent;
  readonly lineage: ActivityWorkIdentityV1;
  /** Durable source event identity when projecting a persisted session event. */
  readonly sourceEventId?: string;
}): readonly ActivityEventV1[] {
  const { event, lineage } = input;
  if (event.type === "actions.requested") {
    return event.data.actions.flatMap((action) => {
      if (action.kind === "subagent-call" || action.kind === "remote-agent-call") return [];
      const kind = action.kind === "load-skill" ? ("skill" as const) : ("tool" as const);
      const rawName = action.kind === "load-skill" ? "load_skill" : action.toolName;
      const name = normalizeActivityText(rawName) || (kind === "skill" ? "Skill" : "Tool");
      const id = deriveActivityActionId({ callId: action.callId, workId: lineage.id });
      return [
        {
          action: {
            id,
            kind,
            name,
            parentWorkId: lineage.id,
            rootTurnId: lineage.rootTurnId,
            stepIndex: event.data.stepIndex,
          },
          eventId: `${id}:started`,
          kind: "action.started" as const,
          startedAt: input.at,
        },
      ];
    });
  }
  if (event.type === "action.result") {
    const result = event.data.result;
    if (result.kind === "subagent-result") {
      if ("backgroundTask" in result && result.backgroundTask !== undefined) return [];
      const workId = deriveChildActivityWorkId({
        callId: result.callId,
        parentSessionId: lineage.sessionId ?? lineage.rootSessionId,
        parentTurnId: lineage.turnId ?? lineage.rootTurnId,
      });
      const outcome =
        result.origin === "dispatch"
          ? "failed"
          : result.outcome.result.kind === "succeeded"
            ? "completed"
            : result.outcome.result.kind === "cancelled"
              ? "cancelled"
              : "failed";
      return [
        {
          eventId: `${workId}:settled:${outcome}`,
          kind: "work.settled",
          outcome,
          settledAt: input.at,
          workId,
        },
      ];
    }
    const id = deriveActivityActionId({ callId: result.callId, workId: lineage.id });
    const settled = {
      actionId: id,
      eventId: `${id}:settled:${event.data.status}`,
      kind: "action.settled" as const,
      outcome: event.data.status,
      settledAt: input.at,
    };
    const taskUpdate = readAcceptedTaskUpdate(result);
    if (lineage.kind !== "task" || taskUpdate === undefined) return [settled];
    return [
      {
        eventId: input.sourceEventId ?? `${lineage.id}:updated:${event.data.sequence}`,
        kind: "work.updated",
        message: taskUpdate,
        updatedAt: input.at,
        workId: lineage.id,
      },
      settled,
    ];
  }
  if (event.type === "authorization.required") {
    const id = blockerId(
      "authorization",
      lineage.id,
      event.data.attemptId ??
        event.data.candidateId ??
        `${event.data.turnId}:${String(event.data.stepIndex)}:${event.data.name}`,
    );
    return [
      {
        blocker: {
          id,
          kind: "authorization",
          label: activityLabel(event.data.authorization?.displayName ?? event.data.name),
          parentWorkId: lineage.id,
          rootTurnId: lineage.rootTurnId,
        },
        eventId: `${id}:started`,
        kind: "blocker.started",
        startedAt: input.at,
      },
    ];
  }
  if (event.type === "authorization.completed") {
    const id = blockerId(
      "authorization",
      lineage.id,
      event.data.attemptId ??
        event.data.candidateId ??
        `${event.data.turnId}:${String(event.data.stepIndex)}:${event.data.name}`,
    );
    const outcome =
      event.data.outcome === "authorized"
        ? "completed"
        : event.data.outcome === "failed"
          ? "failed"
          : "cancelled";
    return [
      {
        blockerId: id,
        eventId: `${id}:settled:${outcome}`,
        kind: "blocker.settled",
        outcome,
        settledAt: input.at,
      },
    ];
  }
  if (event.type === "approval.candidate" && event.data.outcome === "pending") {
    const id = blockerId("approval", lineage.id, event.data.requestId);
    return [
      {
        blocker: {
          id,
          kind: "approval",
          parentWorkId: lineage.id,
          rootTurnId: lineage.rootTurnId,
        },
        eventId: `${id}:started`,
        kind: "blocker.started",
        startedAt: input.at,
      },
    ];
  }
  if (event.type === "approval.settled") {
    const id = blockerId("approval", lineage.id, event.data.requestId);
    const outcome = event.data.outcome === "approved" ? "completed" : "cancelled";
    return [
      {
        blockerId: id,
        eventId: `${id}:settled:${outcome}`,
        kind: "blocker.settled",
        outcome,
        settledAt: input.at,
      },
    ];
  }
  if (event.type === "input.requested") {
    return event.data.requests.map((request) => {
      const kind = request.kind === "tool-approval" ? ("approval" as const) : ("input" as const);
      const id = blockerId(kind, lineage.id, request.requestId);
      return {
        blocker: {
          id,
          kind,
          label: activityLabel(request.prompt),
          parentActionId: deriveActivityActionId({
            callId: request.action.callId,
            workId: lineage.id,
          }),
          parentWorkId: lineage.id,
          rootTurnId: lineage.rootTurnId,
        },
        eventId: `${id}:started`,
        kind: "blocker.started" as const,
        startedAt: input.at,
      };
    });
  }
  if (event.type === "input.resolved") {
    return event.data.resolutions.map((resolution) => {
      const kind = resolution.kind === "tool-approval" ? "approval" : "input";
      const id = blockerId(kind, lineage.id, resolution.requestId);
      const outcome =
        resolution.outcome === "answered" || resolution.outcome === "approved"
          ? "completed"
          : resolution.outcome === "invalid"
            ? "failed"
            : "cancelled";
      return {
        blockerId: id,
        eventId: `${id}:settled:${outcome}`,
        kind: "blocker.settled" as const,
        outcome,
        settledAt: input.at,
      };
    });
  }
  if (
    lineage.kind === "root-turn" &&
    (event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled")
  ) {
    const outcome =
      event.type === "turn.completed"
        ? "completed"
        : event.type === "turn.failed"
          ? "failed"
          : "cancelled";
    return [
      {
        eventId: `${lineage.id}:settled:${outcome}`,
        kind: "work.settled",
        outcome,
        settledAt: input.at,
        workId: lineage.id,
      },
    ];
  }
  return [];
}

function readAcceptedTaskUpdate(
  result: Extract<UnstampedMessageStreamEvent, { type: "action.result" }>["data"]["result"],
): string | undefined {
  if (
    result.kind !== "tool-result" ||
    result.isError === true ||
    result.toolName !== TASK_UPDATE_TOOL_NAME
  ) {
    return undefined;
  }
  const output: unknown = result.output;
  if (
    typeof output !== "object" ||
    output === null ||
    !("status" in output) ||
    output.status !== "sent" ||
    !("message" in output) ||
    typeof output.message !== "string"
  ) {
    return undefined;
  }
  const message = normalizeActivityText(output.message);
  return message === "" ? undefined : message;
}

function activityLabel(value: string): string | undefined {
  const normalized = normalizeActivityText(value);
  return normalized === "" ? undefined : normalized;
}

function blockerId(
  kind: "approval" | "authorization" | "input",
  parentWorkId: string,
  requestId: string,
): string {
  return `${kind}:${parentWorkId}:${requestId}`;
}
