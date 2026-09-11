import type { EveEvalTurn, InputRequest } from "eve/evals";

type Event = EveEvalTurn["events"][number];
export type SessionEvents = Pick<EveEvalTurn, "sessionId" | "events">;
export const CHECKS = ["first", "second", "third"] as const;
export type Check = (typeof CHECKS)[number];

export function requireOriginalTasksHealthy(
  snapshots: readonly SessionEvents[],
  sessionId: string,
  taskIds: readonly string[],
): void {
  for (const event of eventsForSession(snapshots, sessionId)) {
    if (event.type !== "message.received") continue;
    for (const taskId of taskIds) {
      const prefix = `Background task ${taskId} (agent) `;
      const message = event.data.message;
      if (message.startsWith(`${prefix}failed.`) || message.startsWith(`${prefix}is cancelled.`)) {
        throw new Error(
          `Original warehouse task failed or was cancelled; replacement tasks cannot satisfy this eval. ${message.slice(0, 1000)}`,
        );
      }
    }
  }
}

export function checkForTask(taskId: string, requests: readonly InputRequest[]): Check {
  // The parent proxy prefixes the original approval ID with its owning task ID.
  const owned = requests.filter((request) => request.requestId.startsWith(`${taskId}:`));
  const request = owned[0];
  const check = CHECKS.find((candidate) => candidate === request?.action.input.check);
  if (
    owned.length !== 1 ||
    request?.kind !== "tool-approval" ||
    request.action.toolName !== "probe" ||
    check === undefined
  ) {
    throw new Error(
      `Warehouse task ${taskId} needs exactly one probe approval with a valid check.`,
    );
  }
  return check;
}

export function eventsForSession(snapshots: readonly SessionEvents[], sessionId: string): Event[] {
  const events = new Map<string, Event>();
  for (const snapshot of snapshots) {
    if (snapshot.sessionId !== sessionId) continue;
    for (const event of snapshot.events) {
      // Only repeated delivery of the same event is replay, not another result for the same call.
      if (!events.has(event.meta.id)) events.set(event.meta.id, event);
    }
  }
  return [...events.values()];
}

export function childActivations(snapshots: readonly SessionEvents[], sessionId: string) {
  type Called = Extract<Event, { type: "subagent.called" }>["data"];
  const calls = new Map<string, Called>();
  for (const event of eventsForSession(snapshots, sessionId)) {
    if (event.type !== "subagent.called") continue;
    const current = event.data;
    const previous = calls.get(current.callId);
    if (previous !== undefined) {
      // A retried activation notification must still identify the very same child.
      if (
        previous.childSessionId !== current.childSessionId ||
        previous.agentId !== current.agentId ||
        previous.name !== current.name ||
        previous.sessionId !== current.sessionId ||
        previous.turnId !== current.turnId
      ) {
        throw new Error(`Child activation ${current.callId} changed its identity.`);
      }
    } else {
      calls.set(current.callId, current);
    }
  }
  return [...calls.values()];
}

export function toolEvidence(
  snapshots: readonly SessionEvents[],
  sessionId: string,
  toolName: string,
) {
  type Requested = Extract<Event, { type: "actions.requested" }>["data"]["actions"][number];
  type Result = Extract<Event, { type: "action.result" }>["data"];
  const calls = new Map<
    string,
    {
      callId: string;
      inputs: Requested["input"][];
      results: { status: Result["status"]; output: Result["result"]["output"] }[];
    }
  >();
  function call(callId: string) {
    let entry = calls.get(callId);
    if (entry === undefined) {
      entry = { callId, inputs: [], results: [] };
      calls.set(callId, entry);
    }
    return entry;
  }
  for (const event of eventsForSession(snapshots, sessionId)) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind === "tool-call" && action.toolName === toolName) {
          call(action.callId).inputs.push(action.input);
        }
      }
    } else if (event.type === "action.result") {
      const { result, status } = event.data;
      if (result.kind === "tool-result" && result.toolName === toolName) {
        call(result.callId).results.push({ status, output: result.output });
      }
    }
  }
  return [...calls.values()];
}
