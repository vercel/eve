import { createHash, randomUUID } from "node:crypto";

import type {
  ScheduleCreate,
  ScheduleExpression,
  ScheduleList,
  SchedulePage,
  ScheduleProvider,
  ScheduleRecord,
} from "#public/schedules/subscription.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";

export interface InMemoryScheduleProviderOptions {
  readonly now?: () => Date;
}

interface StoredSchedule extends ScheduleRecord {
  readonly payload: unknown;
  readonly target: ScheduleProviderContext["target"];
}

export function inMemoryScheduleProvider(
  options: InMemoryScheduleProviderOptions = {},
): ScheduleProvider {
  const schedules = new Map<string, StoredSchedule>();
  const operationResults = new Map<string, unknown>();
  const scheduleIds = new Map<string, string>();
  const usedScheduleIds = new Set<string>();
  const usedOccurrenceIds = new Set<string>();
  const now = options.now ?? (() => new Date());

  return {
    kind: "in-memory",

    async create<TPayload>(context: ScheduleProviderContext, schedule: ScheduleCreate<TPayload>) {
      return withOperationResult(operationResults, context.operationId, () => {
        const key = scheduleKey(context, schedule.name);
        if (schedules.has(key)) {
          throw new Error(`Schedule ${JSON.stringify(schedule.name)} already exists.`);
        }
        const timestamp = now().getTime();
        const record: StoredSchedule = {
          createdAt: timestamp,
          expression: normalizeExpression(schedule.expression),
          payload: schedule.payload,
          name: schedule.name,
          scheduleId: allocateScheduleId(context, schedule.name, scheduleIds, usedScheduleIds),
          state:
            schedule.expression.type === "single" && Date.parse(schedule.expression.at) <= timestamp
              ? "completed"
              : "active",
          target: context.target,
          updatedAt: timestamp,
        };
        schedules.set(key, record);
        return publicRecord(record);
      });
    },

    async list(context: ScheduleProviderContext, query: ScheduleList): Promise<SchedulePage> {
      const records = [...schedules.entries()]
        .filter(([key]) => key.startsWith(collectionPrefix(context)))
        .map(([, record]) => publicRecord(record))
        .sort((left, right) => left.name.localeCompare(right.name));
      const start = decodeCursor(query.cursor);
      const limit = normalizeLimit(query.limit);
      const data = records.slice(start, start + limit);
      const next = start + data.length;
      return { cursor: next < records.length ? String(next) : null, data };
    },

    async get(context: ScheduleProviderContext, name: string) {
      const record = schedules.get(scheduleKey(context, name));
      return record === undefined ? null : publicRecord(record);
    },

    async enable(context: ScheduleProviderContext, name: string) {
      return setState(schedules, operationResults, context, name, "active", now);
    },

    async disable(context: ScheduleProviderContext, name: string) {
      return setState(schedules, operationResults, context, name, "inactive", now);
    },

    async invoke(context: ScheduleProviderContext, name: string) {
      const replay = operationResults.get(context.operationId) as
        | {
            readonly payload: unknown;
            readonly occurrence: ScheduleRecord & { executionId: string; scheduledAt: string };
          }
        | undefined;
      if (replay !== undefined) {
        if (context.target.deliver !== undefined) await context.target.deliver(replay);
        return;
      }
      const schedule = requireSchedule(schedules, scheduleKey(context, name), name);
      if (schedule.state === "completed")
        throw new Error(`Completed schedule ${JSON.stringify(name)} cannot be invoked.`);
      const scheduledAt = now().toISOString();
      const delivery = {
        payload: schedule.payload,
        occurrence: {
          executionId: allocateOccurrenceId(context.operationId, usedOccurrenceIds),
          name: schedule.name,
          scheduleId: schedule.scheduleId,
          scheduledAt,
        },
      };
      operationResults.set(context.operationId, delivery);
      if (schedule.target.deliver !== undefined) await schedule.target.deliver(delivery);
    },

    async delete(context: ScheduleProviderContext, name: string) {
      return withOperationResult(operationResults, context.operationId, () => {
        const key = scheduleKey(context, name);
        const deleted = schedules.delete(key);
        if (deleted) scheduleIds.delete(key);
        return deleted;
      });
    },
  };
}

async function setState(
  schedules: Map<string, StoredSchedule>,
  operationResults: Map<string, unknown>,
  context: ScheduleProviderContext,
  name: string,
  state: ScheduleRecord["state"],
  now: () => Date,
): Promise<ScheduleRecord> {
  return withOperationResult(operationResults, context.operationId, () => {
    const key = scheduleKey(context, name);
    const current = requireSchedule(schedules, key, name);
    const updated = { ...current, state, updatedAt: now().getTime() };
    schedules.set(key, updated);
    return publicRecord(updated);
  });
}

function requireSchedule(
  schedules: Map<string, StoredSchedule>,
  key: string,
  name: string,
): StoredSchedule {
  const schedule = schedules.get(key);
  if (schedule === undefined) {
    throw new Error(`Schedule ${JSON.stringify(name)} was not found.`);
  }
  return schedule;
}

function withOperationResult<TResult>(
  results: Map<string, unknown>,
  operationId: string,
  operation: () => TResult,
): TResult {
  if (results.has(operationId)) return results.get(operationId) as TResult;
  const result = operation();
  results.set(operationId, result);
  return result;
}

function allocateOccurrenceId(operationId: string, usedOccurrenceIds: Set<string>): string {
  const base = `manual_${createHash("sha256").update(operationId).digest("base64url")}`;
  let occurrenceId = base;
  let suffix = 0;
  while (usedOccurrenceIds.has(occurrenceId)) occurrenceId = `${base}_${++suffix}`;
  usedOccurrenceIds.add(occurrenceId);
  return occurrenceId;
}

function normalizeExpression(expression: ScheduleExpression): ScheduleExpression {
  if (expression.type === "cron") {
    const normalized: {
      type: "cron";
      cron: string;
      timezone?: string;
      jitter?: number;
    } = {
      type: "cron",
      cron: expression.cron.trim().replace(/\s+/gu, " "),
    };
    if (expression.timezone !== undefined) normalized.timezone = expression.timezone;
    if (expression.jitter !== undefined) normalized.jitter = expression.jitter;
    return normalized;
  }
  const normalized: { type: "single"; at: string; timezone?: string } = {
    type: "single",
    at: expression.at,
  };
  if (expression.timezone !== undefined) normalized.timezone = expression.timezone;
  return normalized;
}

function publicRecord(record: StoredSchedule): ScheduleRecord {
  return {
    createdAt: record.createdAt,
    expression: record.expression,
    name: record.name,
    scheduleId: record.scheduleId,
    state: record.state,
    updatedAt: record.updatedAt,
  };
}

function collectionPrefix(context: ScheduleProviderContext): string {
  return `${context.collection}\0${context.namespace}\0`;
}

function scheduleKey(context: ScheduleProviderContext, name: string): string {
  return `${collectionPrefix(context)}${name}`;
}

function allocateScheduleId(
  context: ScheduleProviderContext,
  name: string,
  scheduleIds: Map<string, string>,
  usedScheduleIds: Set<string>,
): string {
  const key = scheduleKey(context, name);
  const existing = scheduleIds.get(key);
  if (existing !== undefined) return existing;
  let scheduleId: string;
  do {
    scheduleId = `mem_${createHash("sha256").update(`${key}:${randomUUID()}`).digest("hex")}`;
  } while (usedScheduleIds.has(scheduleId));
  scheduleIds.set(key, scheduleId);
  usedScheduleIds.add(scheduleId);
  return scheduleId;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Schedule list limit must be an integer from 1 through 100.");
  }
  return limit;
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid schedule cursor.");
  return value;
}
