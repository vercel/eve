import type {
  ScheduleCreate,
  ScheduleExpression,
  ScheduleList,
  SchedulePage,
  SchedulePatch,
  ScheduleProvider,
  ScheduleProviderContext,
  ScheduleRecord,
} from "#public/schedules/collection.js";

export interface InMemoryScheduleProviderOptions {
  readonly now?: () => Date;
}

interface StoredSchedule extends ScheduleRecord {
  readonly input: unknown;
  readonly target: ScheduleProviderContext["target"];
}

export function inMemoryScheduleProvider(
  options: InMemoryScheduleProviderOptions = {},
): ScheduleProvider {
  const schedules = new Map<string, StoredSchedule>();
  const operationResults = new Map<string, unknown>();
  const now = options.now ?? (() => new Date());

  return {
    kind: "in-memory",

    async create<TInput>(context: ScheduleProviderContext, input: ScheduleCreate<TInput>) {
      return withOperationResult(operationResults, context.operationId, () => {
        const key = scheduleKey(context, input.name);
        if (schedules.has(key)) {
          throw new Error(`Schedule ${JSON.stringify(input.name)} already exists.`);
        }
        const timestamp = now().getTime();
        const record: StoredSchedule = {
          createdAt: timestamp,
          expression: normalizeExpression(input.expression),
          input: input.input,
          name: input.name,
          scheduleId: createScheduleId(context, input.name),
          state: input.state ?? "active",
          target: context.target,
          updatedAt: timestamp,
        };
        schedules.set(key, record);
        return publicRecord(record);
      });
    },

    async list(context: ScheduleProviderContext, input: ScheduleList): Promise<SchedulePage> {
      const records = [...schedules.entries()]
        .filter(([key]) => key.startsWith(collectionPrefix(context)))
        .map(([, record]) => publicRecord(record))
        .sort((left, right) => left.name.localeCompare(right.name));
      const start = decodeCursor(input.cursor);
      const limit = normalizeLimit(input.limit);
      const data = records.slice(start, start + limit);
      const next = start + data.length;
      return { cursor: next < records.length ? String(next) : null, data };
    },

    async get(context: ScheduleProviderContext, name: string) {
      const record = schedules.get(scheduleKey(context, name));
      return record === undefined ? null : publicRecord(record);
    },

    async update<TInput>(
      context: ScheduleProviderContext,
      name: string,
      patch: SchedulePatch<TInput>,
    ) {
      return withOperationResult(operationResults, context.operationId, () => {
        const key = scheduleKey(context, name);
        const current = requireSchedule(schedules, key, name);
        const updated: StoredSchedule = {
          ...current,
          expression:
            patch.expression === undefined
              ? current.expression
              : normalizeExpression(patch.expression),
          input: patch.input === undefined ? current.input : patch.input,
          updatedAt: now().getTime(),
        };
        schedules.set(key, updated);
        return publicRecord(updated);
      });
    },

    async enable(context: ScheduleProviderContext, name: string) {
      return setState(schedules, operationResults, context, name, "active", now);
    },

    async disable(context: ScheduleProviderContext, name: string) {
      return setState(schedules, operationResults, context, name, "inactive", now);
    },

    async invoke(context: ScheduleProviderContext, name: string) {
      if (operationResults.has(context.operationId)) return;
      const schedule = requireSchedule(schedules, scheduleKey(context, name), name);
      const firedAt = now().toISOString();
      const delivery = {
        input: schedule.input,
        occurrence: {
          firedAt,
          id: `${schedule.scheduleId}:${firedAt}`,
          name: schedule.name,
          scheduleId: schedule.scheduleId,
        },
      };
      operationResults.set(context.operationId, delivery);
      if (schedule.target.deliver !== undefined) await schedule.target.deliver(delivery);
    },

    async delete(context: ScheduleProviderContext, name: string) {
      return withOperationResult(operationResults, context.operationId, () =>
        schedules.delete(scheduleKey(context, name)),
      );
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

function createScheduleId(context: ScheduleProviderContext, name: string): string {
  return `mem_${Buffer.from(scheduleKey(context, name), "utf8").toString("base64url")}`;
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
