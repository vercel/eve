import { normalizePresentationText } from "#shared/presentation-text.js";
import { deriveChildActivityWorkId } from "#execution/activity-work-id.js";
import type {
  ActivityActionPhase,
  ActivityEventV1,
  ActivityWorkIdentityV1,
} from "#protocol/activity.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { isTaskControlTool } from "#protocol/task-tools.js";

export function projectActivityEvents(input: {
  readonly at: string;
  readonly event: UnstampedMessageStreamEvent;
  readonly eventId?: string;
  readonly lineage: ActivityWorkIdentityV1;
  /** Calls to tasks: their `action.result` is a receipt, and `task.settled` settles them. */
  readonly taskCallIds?: readonly string[];
}): readonly ActivityEventV1[] {
  const { event, lineage } = input;
  if (event.type === "actions.requested") {
    return event.data.actions.flatMap((action) => {
      if (action.kind === "subagent-call" || action.kind === "remote-agent-call") return [];
      if (action.kind === "tool-call" && isTaskControlTool(action.toolName)) return [];
      const kind = action.kind === "load-skill" ? ("skill" as const) : ("tool" as const);
      const rawName = action.kind === "load-skill" ? "load_skill" : action.toolName;
      const name = normalizePresentationText(rawName) || (kind === "skill" ? "Skill" : "Tool");
      const id = actionId(lineage.id, action.callId);
      const label = activityLabel(event.data.presentation?.[action.callId]?.label);
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
        ...(label === undefined
          ? []
          : [
              {
                actionId: id,
                eventId: `${id}:label`,
                kind: "action.label.updated" as const,
                label,
              },
            ]),
      ];
    });
  }
  if (event.type === "action.partial") {
    const id = actionId(lineage.id, event.data.result.callId);
    const label = activityLabel(event.data.presentation?.[event.data.result.callId]?.label);
    return label === undefined
      ? []
      : [
          {
            actionId: id,
            eventId: `${id}:update:${input.eventId ?? input.at}`,
            kind: "action.label.updated",
            label,
          },
        ];
  }
  if (event.type === "action.result") {
    const result = event.data.result;
    if (result.kind === "subagent-result") {
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
    if (result.kind === "tool-result" && isTaskControlTool(result.toolName)) return [];
    const id = actionId(lineage.id, result.callId);
    const label = activityLabel(event.data.presentation?.[result.callId]?.label);
    const labelUpdates =
      label === undefined
        ? []
        : [
            {
              actionId: id,
              eventId: `${id}:result:${input.eventId ?? input.at}`,
              kind: "action.label.updated" as const,
              label,
            },
          ];
    const isTaskReceipt = input.taskCallIds?.includes(result.callId) === true;
    if (isTaskReceipt) return labelUpdates;
    return [...labelUpdates, actionSettled(id, event.data.status, input.at)];
  }
  if (event.type === "task.settled") {
    const id = actionId(lineage.id, event.data.callId);
    return [actionSettled(id, event.data.status, input.at)];
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
  // Delegated work settles here too: its result reaches only the caller's
  // reply hook, never the caller's stream.
  if (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled"
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

function actionSettled(
  id: string,
  outcome: Exclude<ActivityActionPhase, "running">,
  settledAt: string,
): ActivityEventV1 {
  return {
    actionId: id,
    eventId: `${id}:settled:${outcome}`,
    kind: "action.settled",
    outcome,
    settledAt,
  };
}

function activityLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizePresentationText(value);
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
