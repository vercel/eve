import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { isObject } from "#shared/guards.js";

/** Translates v3 task envelopes into generic requests and effects. */
export const sessionInboxWireV3Migration: VersionMigration = {
  from: 3,
  migrate(prior) {
    if (!isObject(prior)) throw new Error("session inbox wire v3 value is not an object.");
    if (prior.kind !== "deliver") return { ...prior, version: 4 };
    return {
      ...prior,
      payload: migratePayload(prior.payload),
      payloads: Array.isArray(prior.payloads) ? prior.payloads.map(migratePayload) : prior.payloads,
      version: 4,
    };
  },
  to: 4,
};

function migratePayload(payload: unknown): unknown {
  if (!isObject(payload) || !isObject(payload.task)) return payload;
  const task = payload.task;
  return {
    ...payload,
    task: {
      authorizationEvents: task.authorizationEvents,
      effects: task.effects ?? migrateAuthorizationEvents(task.authorizationEvents),
      inputRequests: migrateInputRequests(task.inputRequests),
      views: Array.isArray(task.views) ? task.views.map(migrateTaskView) : task.views,
    },
  };
}

function migrateAuthorizationEvents(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    if (!isObject(entry) || !isObject(entry.hookPayload) || typeof entry.taskId !== "string") {
      return [];
    }
    return [
      {
        input: entry.hookPayload,
        name: "agent.event",
        replyTo: "",
        taskId: entry.taskId,
      },
    ];
  });
}

function migrateInputRequests(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    if (!isObject(entry)) return [];
    if ("request" in entry || "requests" in entry) return [entry];
    if (!isObject(entry.hookPayload) || typeof entry.taskId !== "string") return [];
    const hookPayload = entry.hookPayload;
    const event = hookPayload.event;
    if (
      typeof hookPayload.childContinuationToken !== "string" ||
      !isObject(event) ||
      !Array.isArray(event.requests) ||
      typeof event.sequence !== "number" ||
      typeof event.stepIndex !== "number" ||
      typeof event.turnId !== "string"
    ) {
      return [];
    }
    return event.requests.map((request) => ({
      ...entry,
      replyTo: hookPayload.childContinuationToken,
      request,
      sequence: event.sequence,
      stepIndex: event.stepIndex,
      taskId: entry.taskId,
      turnId: event.turnId,
    }));
  });
}

function migrateTaskView(value: unknown): unknown {
  if (!isObject(value) || !isObject(value.executor)) return value;
  return {
    ...value,
    executor:
      value.executor.binding === undefined ? undefined : { binding: value.executor.binding },
  };
}
