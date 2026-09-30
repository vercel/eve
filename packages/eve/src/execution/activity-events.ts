import { normalizePresentationText } from "#shared/presentation-text.js";
import { deriveChildActivityWorkId } from "#execution/activity-work-id.js";
import type {
  ActivityActionPhase,
  ActivityEventV1,
  ActivityWorkIdentityV1,
} from "#protocol/activity.js";
import type { TaskSettledStreamEvent, UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { isTaskControlTool } from "#protocol/task-tools.js";
import { parsePlanItems } from "#protocol/activity.js";
import { PLAN_TOOL_NAME } from "#tools/provided/plan.js";

type TaskSettledActivity = Extract<ActivityEventV1, { readonly kind: "task.settled" }>;

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
      if (action.kind === "tool-call" && isTaskControlTool(action.toolName)) return [];
      const started = projectActionStarted({
        at: input.at,
        callId: action.callId,
        kind: action.kind === "load-skill" ? "skill" : "tool",
        label: event.data.presentation?.[action.callId]?.label,
        lineage,
        name: actionName(action),
        stepIndex: event.data.stepIndex,
      });
      const plan = projectPlan(lineage, action);
      return plan === undefined ? started : [...started, plan];
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
    // Only a child a call started before agents ran as tasks reports its
    // result on the caller's stream, under its unkeyed work id.
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
    // A task call's result is its receipt: `task.settled` settles it, with the real outcome.
    if (input.taskCallIds?.includes(result.callId) === true) return [];
    return [...labelUpdates, actionSettled(id, event.data.status, input.at)];
  }
  if (event.type === "task.started") {
    const id = actionId(lineage.id, event.data.callId);
    return [
      {
        actionId: id,
        eventId: `${id}:task`,
        kind: "task.started",
        taskId: event.data.taskId,
        taskKind: event.data.kind,
      },
    ];
  }
  if (event.type === "task.settled") {
    const id = actionId(lineage.id, event.data.callId);
    const settled: { -readonly [K in keyof TaskSettledActivity]: TaskSettledActivity[K] } = {
      actionId: id,
      eventId: `${id}:settled:${event.data.status}`,
      kind: "task.settled",
      outcome: event.data.status,
      settledAt: input.at,
    };
    const summary = taskSummary(event.data);
    if (summary !== undefined) settled.summary = summary;
    return [settled];
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
  // Delegated work settles here too: an agent session's result reaches its
  // caller's reply hook, not the caller's stream.
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

/** The events that start one action, and its label when it has one. */
export function projectActionStarted(input: {
  readonly at: string;
  readonly callId: string;
  readonly kind: "skill" | "tool";
  readonly label: string | undefined;
  readonly lineage: ActivityWorkIdentityV1;
  readonly name: string;
  readonly stepIndex: number;
}): readonly ActivityEventV1[] {
  const id = actionId(input.lineage.id, input.callId);
  const name = normalizePresentationText(input.name) || (input.kind === "skill" ? "Skill" : "Tool");
  const label = activityLabel(input.label);
  const started: ActivityEventV1 = {
    action: {
      id,
      kind: input.kind,
      name,
      parentWorkId: input.lineage.id,
      rootTurnId: input.lineage.rootTurnId,
      stepIndex: input.stepIndex,
    },
    eventId: `${id}:started`,
    kind: "action.started",
    startedAt: input.at,
  };
  if (label === undefined) return [started];
  return [started, { actionId: id, eventId: `${id}:label`, kind: "action.label.updated", label }];
}

/** A root turn's call to the `plan` tool sets that turn's plan. */
function projectPlan(
  lineage: ActivityWorkIdentityV1,
  action: RuntimeActionRequest,
): ActivityEventV1 | undefined {
  if (lineage.kind !== "root-turn") return undefined;
  if (action.kind !== "tool-call" || action.toolName !== PLAN_TOOL_NAME) return undefined;
  const items = parsePlanItems(action.input.items);
  if (items === undefined) return undefined;
  return {
    eventId: `${actionId(lineage.id, action.callId)}:plan`,
    items,
    kind: "plan.updated",
    rootTurnId: lineage.rootTurnId,
  };
}

function actionName(action: RuntimeActionRequest): string {
  switch (action.kind) {
    case "load-skill":
      return "load_skill";
    case "subagent-call":
      return action.subagentName;
    case "remote-agent-call":
      return action.remoteAgentName;
    default:
      return action.toolName;
  }
}

/** One line describing how a task call ended, for the channel's task row. */
function taskSummary(data: TaskSettledStreamEvent["data"]): string | undefined {
  switch (data.status) {
    case "completed":
      return firstLine(resultText(data.output));
    case "failed":
      return firstLine(data.error?.message);
    case "cancelled":
      return undefined;
  }
}

/** The text a result leads with: a string result, or an agent reply's message. */
function resultText(output: JsonValue | undefined): unknown {
  if (typeof output === "string") return output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const fields = output as JsonObject;
  return fields.message ?? fields.text ?? fields.summary;
}

function firstLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return line === undefined ? undefined : normalizePresentationText(line) || undefined;
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
