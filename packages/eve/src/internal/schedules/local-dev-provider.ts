import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { resolveDevelopmentStateDirectory } from "#internal/application/dev-environment.js";
import {
  nextFireAtMs,
  sharedLocalDevScheduleStore,
  type LocalDevScheduleRow,
  type LocalDevScheduleStore,
} from "#internal/schedules/local-dev-store.js";
import {
  decodeScheduleCursor,
  normalizeScheduleExpression,
  normalizeScheduleLimit,
} from "#internal/schedules/provider-utils.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";
import type {
  ScheduleExpression,
  SchedulePage,
  ScheduleProvider,
  ScheduleRecord,
} from "#public/schedules/subscription.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";

export const LOCAL_DEV_SCHEDULE_DATABASE_FILE = "schedules.db";

export function resolveLocalDevScheduleDatabasePath(appRoot: string): string {
  return join(resolveDevelopmentStateDirectory(appRoot), LOCAL_DEV_SCHEDULE_DATABASE_FILE);
}

export function localDevScheduleProvider(options: {
  readonly validateExpression: (expression: ScheduleExpression) => void | Promise<void>;
}): ScheduleProvider {
  const store = (): LocalDevScheduleStore => {
    const appRoot = process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
    if (!appRoot) {
      throw new Error(
        `eve dev's schedule store needs the dev worker's app root in ${DEVELOPMENT_WORKER_APP_ROOT_ENV}.`,
      );
    }
    return sharedLocalDevScheduleStore(resolveLocalDevScheduleDatabasePath(appRoot));
  };
  const requireRow = (
    schedules: LocalDevScheduleStore,
    context: ScheduleProviderContext,
    name: string,
  ) => {
    const row = schedules.get(context.collection, context.namespace, name);
    if (row === undefined) throw new Error(`Schedule ${JSON.stringify(name)} was not found.`);
    return row;
  };
  const save = (schedules: LocalDevScheduleStore, row: LocalDevScheduleRow) => {
    schedules.put(row);
    return publicRecord(row);
  };

  return {
    kind: "local-dev",
    validateExpression: options.validateExpression,

    async create(context, schedule) {
      const schedules = store();
      return schedules.operation(context.operationId, () => {
        if (schedules.get(context.collection, context.namespace, schedule.name) !== undefined) {
          throw new Error(`Schedule ${JSON.stringify(schedule.name)} already exists.`);
        }
        const timestamp = Date.now();
        const expression = normalizeScheduleExpression(schedule.expression);
        const next = nextFireAtMs(expression, timestamp);
        return save(schedules, {
          collection: context.collection,
          namespace: context.namespace,
          name: schedule.name,
          scheduleId: `local_${randomUUID()}`,
          state: next === null ? "completed" : "active",
          expression,
          payload: schedule.payload,
          nextFireAtMs: next,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      });
    },

    async list(context, query): Promise<SchedulePage> {
      const records = store()
        .list(context.collection, context.namespace)
        .map((row) => publicRecord(row));
      const start = decodeScheduleCursor(query.cursor);
      const data = records.slice(start, start + normalizeScheduleLimit(query.limit));
      const next = start + data.length;
      return { cursor: next < records.length ? String(next) : null, data };
    },

    async get(context, name) {
      const row = store().get(context.collection, context.namespace, name);
      return row === undefined ? null : publicRecord(row);
    },

    async update(context, name, patch) {
      const schedules = store();
      return schedules.operation(context.operationId, () => {
        const current = requireRow(schedules, context, name);
        const timestamp = Date.now();
        const expression =
          patch.expression === undefined
            ? current.expression
            : normalizeScheduleExpression(patch.expression);
        const next =
          current.state === "active" ? nextFireAtMs(expression, timestamp) : current.nextFireAtMs;
        return save(schedules, {
          ...current,
          expression,
          payload: patch.payload === undefined ? current.payload : patch.payload,
          nextFireAtMs: next,
          state: current.state === "active" && next === null ? "completed" : current.state,
          updatedAt: timestamp,
        });
      });
    },

    async enable(context, name) {
      const schedules = store();
      return schedules.operation(context.operationId, () => {
        const current = requireRow(schedules, context, name);
        const timestamp = Date.now();
        const next = nextFireAtMs(current.expression, timestamp);
        return save(schedules, {
          ...current,
          nextFireAtMs: next,
          state: next === null ? "completed" : "active",
          updatedAt: timestamp,
        });
      });
    },

    async disable(context, name) {
      const schedules = store();
      return schedules.operation(context.operationId, () =>
        save(schedules, {
          ...requireRow(schedules, context, name),
          nextFireAtMs: null,
          state: "inactive",
          updatedAt: Date.now(),
        }),
      );
    },

    async invoke(context, name) {
      const schedules = store();
      const delivery = schedules.operation(context.operationId, () => {
        const row = requireRow(schedules, context, name);
        if (row.state === "completed")
          throw new Error(`Completed schedule ${JSON.stringify(name)} cannot be invoked.`);
        return {
          payload: row.payload,
          occurrence: {
            executionId: `manual_${createHash("sha256").update(context.operationId).digest("base64url")}`,
            name: row.name,
            scheduleId: row.scheduleId,
            scheduledAt: new Date().toISOString(),
          },
        };
      });
      if (context.target.deliver === undefined)
        throw new Error("This schedule context cannot deliver occurrences.");
      await context.target.deliver(delivery);
    },

    async delete(context, name) {
      const schedules = store();
      return schedules.operation(context.operationId, () =>
        schedules.remove(context.collection, context.namespace, name),
      );
    },
  };
}

function publicRecord(row: LocalDevScheduleRow): ScheduleRecord {
  return {
    createdAt: row.createdAt,
    expression: row.expression,
    name: row.name,
    scheduleId: row.scheduleId,
    state: row.state,
    updatedAt: row.updatedAt,
  };
}
