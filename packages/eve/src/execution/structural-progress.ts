import type { ContextContainer } from "#context/container.js";
import { CapabilitiesKey, ProgressGroupKey, SessionKey, type Session } from "#context/keys.js";
import { submitProgressCommand } from "#execution/submit-progress.js";
import {
  normalizeProgressText,
  progressActionId,
  progressTurnId,
  type ProgressCommandV1,
  type ProgressEntityV1,
  type ProgressEventV1,
  type ProgressPhase,
} from "#execution/session-progress.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#runtime/actions/types.js";

/** Projects one durable lifecycle event into compact status state. */
export function projectStructuralProgress(
  session: Session,
  event: MessageStreamEvent,
  progressGroupId?: string,
): ProgressCommandV1 | undefined {
  const events = projectEvents(session, event, progressGroupId);
  if (events.length === 0) return undefined;
  return {
    commandId: `structural:${session.sessionId}:${event.meta.id}`,
    events,
    kind: "progress",
    version: 1,
  };
}

/** Best-effort observer used only by progress-enabled sessions. */
export async function publishStructuralProgress(
  ctx: ContextContainer,
  event: MessageStreamEvent,
): Promise<void> {
  if (ctx.get(CapabilitiesKey)?.progress !== true) return;
  const session = ctx.require(SessionKey);
  const command = projectStructuralProgress(session, event, ctx.get(ProgressGroupKey));
  if (command === undefined) return;

  try {
    await submitProgressCommand(ctx, command);
  } catch {
    // Presentation cannot fail the agent's actual work.
  }
}

function projectEvents(
  session: Session,
  event: MessageStreamEvent,
  progressGroupId?: string,
): readonly ProgressEventV1[] {
  switch (event.type) {
    case "turn.started":
      return [
        {
          eventId: eventId(session, event),
          kind: "turn",
          turn: {
            groupId: progressGroupId,
            id: progressTurnId(session.sessionId, event.data.turnId),
            phase: "running",
            sequence: event.data.sequence,
            startedAt: event.meta.at,
          },
        },
      ];
    case "turn.completed":
      return [turnSettlement(session, event, "completed", progressGroupId)];
    case "turn.failed":
      return [turnSettlement(session, event, "failed", progressGroupId)];
    case "turn.cancelled":
      return [turnSettlement(session, event, "cancelled", progressGroupId)];
    case "actions.requested":
      return event.data.actions.map((action) => ({
        entity: actionEntity(session, event.data.turnId, action, "running", progressGroupId),
        eventId: eventId(session, event, action.callId),
        kind: "entity",
      }));
    case "action.result":
      return [
        {
          entity: actionEntity(
            session,
            event.data.turnId,
            resultAsAction(event.data.result),
            resultPhase(event.data.result, event.data.status),
            progressGroupId,
          ),
          eventId: eventId(session, event, event.data.result.callId),
          kind: "entity",
        },
      ];
    case "input.requested":
      return event.data.requests.map((request) => ({
        entity: blocker(
          session,
          event.data.turnId,
          `input:${session.sessionId}:${request.requestId}`,
          request.prompt,
          "blocked",
          progressGroupId,
        ),
        eventId: eventId(session, event, request.requestId),
        kind: "entity",
      }));
    case "input.resolved":
      return event.data.resolutions.map((resolution) => ({
        entity: blocker(
          session,
          event.data.turnId,
          `input:${session.sessionId}:${resolution.requestId}`,
          resolution.kind,
          resolution.outcome === "invalid" ? "failed" : "completed",
          progressGroupId,
        ),
        eventId: eventId(session, event, resolution.requestId),
        kind: "entity",
      }));
    case "authorization.required":
    case "authorization.completed": {
      const id = event.data.attemptId ?? `${event.data.turnId}:${event.data.name}`;
      const required = event.type === "authorization.required";
      return [
        {
          entity: blocker(
            session,
            event.data.turnId,
            `authorization:${session.sessionId}:${id}`,
            required ? event.data.description : event.data.name,
            required ? "blocked" : event.data.outcome === "authorized" ? "completed" : "failed",
            progressGroupId,
          ),
          eventId: eventId(session, event),
          kind: "entity",
        },
      ];
    }
    default:
      return [];
  }
}

function turnSettlement(
  session: Session,
  event: Extract<MessageStreamEvent, { type: "turn.cancelled" | "turn.completed" | "turn.failed" }>,
  phase: Extract<ProgressPhase, "cancelled" | "completed" | "failed">,
  groupId?: string,
): ProgressEventV1 {
  return {
    eventId: eventId(session, event),
    kind: "turn",
    turn: {
      groupId,
      id: progressTurnId(session.sessionId, event.data.turnId),
      phase,
      sequence: event.data.sequence,
      settledAt: event.meta.at,
      startedAt: event.meta.at,
    },
  };
}

function actionEntity(
  session: Session,
  turnId: string,
  action: RuntimeActionRequest,
  phase: ProgressPhase,
  groupId?: string,
): ProgressEntityV1 {
  const base = {
    groupId,
    id: progressActionId(session.sessionId, action.callId),
    phase,
    turnId: progressTurnId(session.sessionId, turnId),
  };
  switch (action.kind) {
    case "load-skill":
      return { ...base, kind: "skill", label: "Loading skill" };
    case "remote-agent-call":
      return { ...base, kind: "remote-agent", label: action.name };
    case "subagent-call":
      return { ...base, kind: "subagent", label: action.name };
    case "tool-call":
      return { ...base, kind: "tool", label: action.toolName };
  }
}

function blocker(
  session: Session,
  turnId: string,
  id: string,
  label: string,
  phase: ProgressPhase,
  groupId?: string,
): ProgressEntityV1 {
  return {
    groupId,
    id,
    kind: "blocker",
    label: normalizeProgressText(label),
    phase,
    turnId: progressTurnId(session.sessionId, turnId),
  };
}

function resultAsAction(result: RuntimeActionResult): RuntimeActionRequest {
  switch (result.kind) {
    case "load-skill-result":
      return { callId: result.callId, input: {}, kind: "load-skill" };
    case "subagent-result":
      return {
        callId: result.callId,
        description: result.subagentName,
        input: {},
        kind: "subagent-call",
        name: result.subagentName,
        nodeId: "",
        subagentName: result.subagentName,
      };
    case "tool-result":
      return { callId: result.callId, input: {}, kind: "tool-call", toolName: result.toolName };
  }
}

function resultPhase(
  result: RuntimeActionResult,
  status: "completed" | "failed" | "rejected",
): ProgressPhase {
  return result.kind === "subagent-result" &&
    result.origin === "child" &&
    result.backgroundTask !== undefined
    ? "running"
    : status === "completed"
      ? "completed"
      : "failed";
}

function eventId(session: Session, event: MessageStreamEvent, suffix?: string): string {
  return `stream:${session.sessionId}:${event.meta.id}${suffix === undefined ? "" : `:${suffix}`}`;
}
