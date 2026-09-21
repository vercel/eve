import { isDeepStrictEqual } from "node:util";

import type { EveEvalTurn, InputRequest } from "eve/evals";

type Event = EveEvalTurn["events"][number];
export type SessionEvents = Pick<EveEvalTurn, "sessionId" | "events">;
export const CHECKS = ["first", "second", "third"] as const;
export type Check = (typeof CHECKS)[number];
const COMPLETION = /Background task (task_[a-z0-9]+) \([^)]+\) is completed\./giu;

/** Counts logical model steps while tolerating durable step retries with new event IDs. */
export function modelStepCount(snapshots: readonly SessionEvents[]): number {
  const steps = new Set<string>();
  for (const snapshot of snapshots) {
    for (const event of snapshot.events) {
      if (event.type !== "step.started") continue;
      steps.add(
        JSON.stringify([
          snapshot.sessionId,
          event.data.turnId,
          event.data.sequence,
          event.data.stepIndex,
          event.data.modelId,
        ]),
      );
    }
  }
  return steps.size;
}

/** Extracts each logical notification once without hiding duplicates inside one message. */
export function completedTaskIds(snapshot: SessionEvents): string[] {
  const messages = new Set<string>();
  const taskIds: string[] = [];
  for (const event of snapshot.events) {
    if (event.type !== "message.received") continue;
    const logicalMessage = JSON.stringify([
      event.data.turnId,
      event.data.sequence,
      event.data.message,
    ]);
    if (messages.has(logicalMessage)) continue;
    messages.add(logicalMessage);
    taskIds.push(...[...event.data.message.matchAll(COMPLETION)].map((match) => match[1]));
  }
  return taskIds;
}

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
  function appendRetry<T>(values: T[], value: T, label: string): void {
    const previous = values[0];
    if (previous === undefined) {
      values.push(value);
    } else if (!isDeepStrictEqual(previous, value)) {
      throw new Error(`Retried ${label} changed its value.`);
    }
  }
  for (const event of eventsForSession(snapshots, sessionId)) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        if (action.kind === "tool-call" && action.toolName === toolName) {
          appendRetry(call(action.callId).inputs, action.input, `tool input ${action.callId}`);
        }
      }
    } else if (event.type === "action.result") {
      const { result, status } = event.data;
      if (result.kind === "tool-result" && result.toolName === toolName) {
        appendRetry(
          call(result.callId).results,
          { status, output: result.output },
          `tool result ${result.callId}`,
        );
      }
    }
  }
  return [...calls.values()];
}
