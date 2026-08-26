import { normalizeActivityText } from "#execution/activity-text.js";
import type { ActivityEventV1, ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

export function projectActivityEvents(input: {
  readonly at: string;
  readonly event: UnstampedMessageStreamEvent;
  readonly lineage: ActivityWorkIdentityV1;
}): readonly ActivityEventV1[] {
  const { event, lineage } = input;
  if (event.type === "actions.requested") {
    return event.data.actions.flatMap((action) => {
      if (action.kind === "subagent-call" || action.kind === "remote-agent-call") return [];
      const kind = action.kind === "load-skill" ? ("skill" as const) : ("tool" as const);
      const rawName = action.kind === "load-skill" ? "load_skill" : action.toolName;
      const name = normalizeActivityText(rawName) || (kind === "skill" ? "Skill" : "Tool");
      const id = actionId(lineage.id, action.callId);
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
    if (result.kind === "subagent-result") return [];
    const id = actionId(lineage.id, result.callId);
    return [
      {
        actionId: id,
        eventId: `${id}:settled:${event.data.status}`,
        kind: "action.settled",
        outcome: event.data.status,
        settledAt: input.at,
      },
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
          parentActionId: actionId(lineage.id, request.action.callId),
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

function activityLabel(value: string): string | undefined {
  const normalized = normalizeActivityText(value);
  return normalized === "" ? undefined : normalized;
}

function actionId(parentWorkId: string, callId: string): string {
  return `action:${parentWorkId}:${callId}`;
}

function blockerId(
  kind: "approval" | "authorization" | "input",
  parentWorkId: string,
  requestId: string,
): string {
  return `${kind}:${parentWorkId}:${requestId}`;
}
