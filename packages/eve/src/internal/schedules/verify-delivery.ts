import type { Schedule as VercelSchedule } from "#compiled/@vercel/schedules/index.js";
import { z } from "#compiled/zod/index.js";

import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

const referenceSchema = z.string().min(1);
const queueMessageSchema = z.looseObject({
  executionId: referenceSchema.optional(),
  firedAt: z.string().optional(),
  name: referenceSchema,
  namespace: referenceSchema,
  payload: z.looseObject({
    eve: z.looseObject({
      application: referenceSchema,
      collection: referenceSchema,
      version: z.literal(1),
    }),
    // The common occurrence dispatcher owns validation of the inner eve envelope.
    payload: z.unknown(),
  }),
  scheduleId: referenceSchema,
  scheduledAt: z.string().optional(),
  source: z.literal("dynamic"),
});

export type VerifiedScheduleMessage = z.infer<typeof queueMessageSchema>;

export class PermanentScheduleMessageError extends Error {}

export function expectScheduleQueueMessage(value: unknown): VerifiedScheduleMessage {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new PermanentScheduleMessageError("Invalid eve schedule queue message.");
  }
  if (json === undefined)
    throw new PermanentScheduleMessageError("Invalid eve schedule queue message.");
  if (Buffer.byteLength(json) > 256 * 1024)
    throw new PermanentScheduleMessageError("Schedule queue message exceeds the payload limit.");
  const parsed = queueMessageSchema.safeParse(JSON.parse(json));
  if (!parsed.success)
    throw new PermanentScheduleMessageError("Invalid eve schedule queue message.");
  return parsed.data;
}

export function verifyScheduleDelivery(
  message: VerifiedScheduleMessage,
  schedule: VercelSchedule | null,
  application: string,
  topic: string,
): void {
  if (
    message.payload.eve.application !== application ||
    topic !== deriveEveScheduleQueueTopic(application) ||
    schedule === null ||
    schedule.scheduleId !== message.scheduleId ||
    schedule.name !== message.name ||
    schedule.namespace !== message.namespace ||
    schedule.source !== "dynamic" ||
    schedule.target.type !== "queue" ||
    schedule.target.topic !== topic
  ) {
    throw new PermanentScheduleMessageError("Schedule delivery does not match this agent.");
  }
}
