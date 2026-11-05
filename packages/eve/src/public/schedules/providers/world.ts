import {
  registeredWorldScheduleStore,
  scheduleKey,
  type ScheduleStore,
  type StoredWorldSchedule,
} from "#execution/world-host/schedule-store.js";
import type {
  ScheduleExpression,
  ScheduleProvider,
  ScheduleRecord,
} from "#public/schedules/subscription.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";
import { createUlid } from "#shared/ulid.js";

// Dynamic schedules kept on the World of the World host that runs the agent: they last across
// processes and deployments as its sessions do, and the host fires each occurrence on its `tick`,
// once per schedule and minute however many processes tick. Cron expressions are read in UTC.

/** A schedule provider that keeps schedules on the World host's World. */
export function worldScheduleProvider(): ScheduleProvider {
  const store = (): ScheduleStore => {
    const held = registeredWorldScheduleStore();
    if (held === undefined)
      throw new Error(
        "worldScheduleProvider() keeps schedules on a World host's World: none runs here.",
      );
    return held;
  };
  const keyOf = (context: ScheduleProviderContext, name: string) =>
    scheduleKey(context.collection, context.namespace, name);
  const required = (schedule: StoredWorldSchedule | undefined, name: string) => {
    if (schedule === undefined) throw new Error(`Schedule ${JSON.stringify(name)} was not found.`);
    return schedule;
  };
  const setState = (
    context: ScheduleProviderContext,
    name: string,
    state: ScheduleRecord["state"],
  ) =>
    store().change((table) => {
      const current = required(table.schedules[keyOf(context, name)], name);
      const updated = { ...current, state, updatedAt: Date.now() };
      table.schedules[keyOf(context, name)] = updated;
      return publicRecord(updated);
    }, context.operationId);

  return {
    kind: "world",

    async create(context, schedule) {
      return await store().change((table) => {
        const key = keyOf(context, schedule.name);
        if (table.schedules[key] !== undefined)
          throw new Error(`Schedule ${JSON.stringify(schedule.name)} already exists.`);
        const now = Date.now();
        const stored: StoredWorldSchedule = {
          application: context.target.key,
          collection: context.collection,
          createdAt: now,
          expression: normalized(schedule.expression),
          name: schedule.name,
          namespace: context.namespace,
          payload: schedule.payload,
          scheduleId: `wsch_${createUlid()}`,
          state:
            schedule.expression.type === "single" && Date.parse(schedule.expression.at) <= now
              ? "completed"
              : "active",
          updatedAt: now,
        };
        table.schedules[key] = stored;
        return publicRecord(stored);
      }, context.operationId);
    },

    async list(context, query) {
      const prefix = scheduleKey(context.collection, context.namespace, "");
      const records = Object.entries((await store().read()).schedules)
        .filter(([key]) => key.startsWith(prefix))
        .map(([, schedule]) => publicRecord(schedule))
        .sort((left, right) => left.name.localeCompare(right.name));
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      if (!Number.isSafeInteger(start) || start < 0) throw new Error("Invalid schedule cursor.");
      const limit = query.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Schedule list limit must be an integer from 1 through 100.");
      const data = records.slice(start, start + limit);
      const next = start + data.length;
      return { cursor: next < records.length ? String(next) : null, data };
    },

    async get(context, name) {
      const schedule = (await store().read()).schedules[keyOf(context, name)];
      return schedule === undefined ? null : publicRecord(schedule);
    },

    async update(context, name, patch) {
      return await store().change((table) => {
        const current = required(table.schedules[keyOf(context, name)], name);
        const updated: StoredWorldSchedule = {
          ...current,
          ...(patch.expression !== undefined && { expression: normalized(patch.expression) }),
          ...(patch.payload !== undefined && { payload: patch.payload }),
          updatedAt: Date.now(),
        };
        table.schedules[keyOf(context, name)] = updated;
        return publicRecord(updated);
      }, context.operationId);
    },

    enable: async (context, name) => await setState(context, name, "active"),
    disable: async (context, name) => await setState(context, name, "inactive"),

    async invoke(context, name) {
      const schedule = required((await store().read()).schedules[keyOf(context, name)], name);
      if (schedule.state === "completed")
        throw new Error(`Completed schedule ${JSON.stringify(name)} cannot be invoked.`);
      await context.target.deliver?.({
        occurrence: {
          executionId: `manual_${context.operationId}`,
          name: schedule.name,
          scheduleId: schedule.scheduleId,
          scheduledAt: new Date().toISOString(),
        },
        payload: schedule.payload,
      });
    },

    async delete(context, name) {
      return await store().change((table) => {
        const key = keyOf(context, name);
        const had = table.schedules[key] !== undefined;
        delete table.schedules[key];
        return had;
      }, context.operationId);
    },
  };
}

function normalized(expression: ScheduleExpression): ScheduleExpression {
  return expression.type === "cron"
    ? { ...expression, cron: expression.cron.trim().replace(/\s+/gu, " ") }
    : expression;
}

function publicRecord(schedule: StoredWorldSchedule): ScheduleRecord {
  return {
    createdAt: schedule.createdAt,
    expression: schedule.expression,
    name: schedule.name,
    scheduleId: schedule.scheduleId,
    state: schedule.state,
    updatedAt: schedule.updatedAt,
    ...(schedule.displayName !== undefined && { displayName: schedule.displayName }),
  };
}
