import type { Schedule as VercelSchedule } from "@vercel/schedules";

import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

export interface ScheduleQueueMessage {
  readonly executionId?: string;
  readonly firedAt?: string;
  readonly name: string;
  readonly namespace: string;
  readonly payload?: {
    readonly eve?: {
      readonly application?: string;
      readonly collection?: string;
      readonly version?: number;
    };
    readonly input?: unknown;
  };
  readonly scheduleId: string;
  readonly scheduledAt?: string;
  readonly source: string;
}

export interface VerifiedScheduleMessage extends ScheduleQueueMessage {
  readonly payload: {
    readonly eve: {
      readonly application: string;
      readonly collection: string;
      readonly version: 1;
    };
    readonly input: unknown;
  };
}

export class PermanentScheduleMessageError extends Error {}

export function expectScheduleQueueMessage(value: unknown): VerifiedScheduleMessage {
  if (typeof value !== "object" || value === null) {
    throw new PermanentScheduleMessageError("Invalid eve schedule queue message.");
  }
  const message = value as ScheduleQueueMessage;
  if (
    typeof message.scheduleId !== "string" ||
    typeof message.name !== "string" ||
    typeof message.namespace !== "string" ||
    message.source !== "dynamic" ||
    typeof message.payload !== "object" ||
    message.payload === null ||
    typeof message.payload.eve !== "object" ||
    message.payload.eve === null ||
    message.payload.eve.version !== 1 ||
    typeof message.payload.eve.application !== "string" ||
    typeof message.payload.eve.collection !== "string"
  ) {
    throw new PermanentScheduleMessageError("Invalid eve schedule queue message.");
  }
  if (Buffer.byteLength(JSON.stringify(message)) > 256 * 1024) {
    throw new PermanentScheduleMessageError("Schedule queue message exceeds the payload limit.");
  }
  return message as VerifiedScheduleMessage;
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
