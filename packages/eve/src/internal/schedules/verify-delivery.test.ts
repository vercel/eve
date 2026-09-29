import { describe, expect, it } from "vitest";
import type { Schedule as VercelSchedule } from "@vercel/schedules";

import {
  expectScheduleQueueMessage,
  PermanentScheduleMessageError,
  verifyScheduleDelivery,
} from "#internal/schedules/verify-delivery.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

const application = "test-agent";
const topic = deriveEveScheduleQueueTopic(application);
const message = {
  executionId: "execution_1",
  name: "reminder",
  namespace: "eve-scope-a",
  payload: {
    eve: { application, collection: "reminders", version: 1 },
    payload: "Review open incidents",
  },
  scheduleId: "sch_1",
  scheduledAt: "2026-09-23T12:00:00.000Z",
  source: "dynamic",
};
const schedule = {
  name: message.name,
  namespace: message.namespace,
  scheduleId: message.scheduleId,
  source: "dynamic",
  target: { type: "queue", topic },
} as VercelSchedule;

describe("schedule queue delivery", () => {
  it("accepts a bounded, versioned dynamic occurrence matching its current resource", () => {
    const parsed = expectScheduleQueueMessage(message);
    expect(() => verifyScheduleDelivery(parsed, schedule, application, topic)).not.toThrow();
  });

  it.each([
    null,
    { ...message, source: "static" },
    { ...message, payload: { ...message.payload, eve: { ...message.payload.eve, version: 2 } } },
    { ...message, payload: { ...message.payload, payload: "x".repeat(256 * 1024) } },
  ])("rejects invalid or oversized queue bodies", (body) => {
    expect(() => expectScheduleQueueMessage(body)).toThrow(PermanentScheduleMessageError);
  });

  it.each([
    [{ ...schedule, scheduleId: "sch_other" }, topic],
    [{ ...schedule, namespace: "eve-other" }, topic],
    [{ ...schedule, target: { type: "queue", topic: "other" } }, topic],
    [schedule, deriveEveScheduleQueueTopic("another-agent")],
    [null, topic],
  ] as const)("rejects a different resource or topic", (record, receivedTopic) => {
    expect(() =>
      verifyScheduleDelivery(
        expectScheduleQueueMessage(message),
        record,
        application,
        receivedTopic,
      ),
    ).toThrow(PermanentScheduleMessageError);
  });
});
