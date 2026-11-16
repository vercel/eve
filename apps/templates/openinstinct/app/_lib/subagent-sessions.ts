import type { SessionStreamEvent } from "eve/client";
import { call, type SessionView, task } from "eve/events";
import { z } from "zod";

type ChildOpenedEvent = Extract<SessionStreamEvent, { type: "child.opened" }>;

export interface SubagentSession {
  /** The latest parent call that reached this child. */
  readonly callId?: string;
  readonly childSessionId: string;
  readonly name: string;
  /** The parent's record of the child, which authorizes reading it through the parent. */
  readonly opened: ChildOpenedEvent;
  /** Where the parent's own call or task stands, before the child stream is read. */
  readonly parentStatus?: SubagentStatus;
  readonly task?: string;
}

export type SubagentStatus =
  | "cancelled"
  | "complete"
  | "failed"
  | "ready"
  | "starting"
  | "working";

const delegatedInputSchema = z.object({ message: z.string() });

export function collectSubagentSessions(
  events: readonly SessionStreamEvent[],
  view: SessionView,
  childOpenings: readonly ChildOpenedEvent[] = []
): readonly SubagentSession[] {
  const openings = new Map<string, ChildOpenedEvent>();
  const childByTask = new Map<string, string>();
  for (const event of [...childOpenings, ...events]) {
    if (event.type !== "child.opened") continue;
    openings.set(event.data.sessionId, event);
    const taskId = ownerTaskId(event, view);
    if (taskId) childByTask.set(taskId, event.data.sessionId);
  }

  // A resumable task reuses its child, so each later call moves it forward.
  const latest = new Map<string, { callId?: string; order: number }>();
  for (const [order, event] of events.entries()) {
    if (event.type === "child.opened") {
      const { owner, sessionId } = event.data;
      const callId =
        "callId" in owner ? owner.callId : task(view, owner.taskId)?.callId;
      latest.set(sessionId, {
        callId: latest.get(sessionId)?.callId ?? callId,
        order,
      });
      continue;
    }
    if (event.type === "child.sent") {
      latest.set(event.data.sessionId, { callId: event.data.callId, order });
    }
    if (event.type === "call.started" && event.data.taskId !== undefined) {
      const sessionId = childByTask.get(event.data.taskId);
      if (sessionId)
        latest.set(sessionId, { callId: event.data.callId, order });
    }
  }

  return [...openings.values()]
    .map((opened) => {
      const { callId } = latest.get(opened.data.sessionId) ?? {};
      return {
        callId,
        childSessionId: opened.data.sessionId,
        name: opened.data.name,
        opened,
        parentStatus: parentStatus(view, ownerTaskId(opened, view), callId),
        task: delegatedTask(view, callId),
      };
    })
    .toSorted(
      (left, right) =>
        (latest.get(right.childSessionId)?.order ?? 0) -
        (latest.get(left.childSessionId)?.order ?? 0)
    );
}

export function getSubagentSubscriptionKey(
  sessions: readonly SubagentSession[]
) {
  return sessions
    .map(
      (session) =>
        `${encodeURIComponent(session.childSessionId)}:${encodeURIComponent(session.callId ?? "")}`
    )
    .join("\n");
}

export function getSubagentStatus(
  events: readonly SessionStreamEvent[],
  session: SubagentSession
): SubagentStatus {
  const ended = events.findLast((event) => event.type === "session.ended");
  if (ended?.type === "session.ended") {
    return ended.data.outcome === "failed" ? "failed" : "complete";
  }

  const latestTurn = events.findLast(
    (event) => event.type === "turn.started" || event.type === "turn.settled"
  );
  if (latestTurn?.type === "turn.started") return "working";
  if (latestTurn?.type === "turn.settled") {
    switch (latestTurn.data.outcome) {
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      default:
        return "ready";
    }
  }
  return session.parentStatus ?? "starting";
}

export function getSubagentTask(events: readonly SessionStreamEvent[]) {
  const consumed = events.find((event) => event.type === "delivery.consumed");
  if (consumed?.type !== "delivery.consumed") return undefined;
  return conciseTask(
    consumed.data.parts
      .flatMap((part) => (part.kind === "text" ? [part.text] : []))
      .join("\n")
  );
}

/** The task a child serves: its owner, or the task behind the call that opened it. */
function ownerTaskId(opened: ChildOpenedEvent, view: SessionView) {
  const { owner } = opened.data;
  return (
    ("taskId" in owner ? owner.taskId : call(view, owner.callId)?.taskId) ??
    opened.scope?.taskId
  );
}

function parentStatus(
  view: SessionView,
  taskId: string | undefined,
  callId: string | undefined
): SubagentStatus | undefined {
  const owningTask = taskId === undefined ? undefined : task(view, taskId);
  if (owningTask?.status === "ended") {
    switch (owningTask.outcome) {
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
      default:
        return "complete";
    }
  }

  // A task's child stays available for later calls once a call settles.
  switch (callId === undefined ? undefined : call(view, callId)?.state) {
    case "completed":
      return "ready";
    case "failed":
      return owningTask ? "ready" : "failed";
    case "cancelled":
    case "rejected":
      return owningTask ? "ready" : "cancelled";
    default:
      return undefined;
  }
}

function delegatedTask(view: SessionView, callId: string | undefined) {
  if (callId === undefined) return undefined;
  const input = delegatedInputSchema.safeParse(call(view, callId)?.input);
  return input.success ? conciseTask(input.data.message) : undefined;
}

function conciseTask(message: string) {
  return message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^Task:\s*/iu, "");
}
