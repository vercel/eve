import type {
  Schedule as VercelSchedule,
  SchedulesClient,
} from "#compiled/@vercel/schedules/index.js";

import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import type {
  ScheduleExpression,
  SchedulePage,
  ScheduleProvider,
  ScheduleRecord,
} from "#public/schedules/subscription.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

const DEVELOPMENT_PROVIDER = inMemoryScheduleProvider();
const CLIENT_OPTIONS = new WeakMap<ScheduleProvider, VercelScheduleProviderOptions>();

/** Client options of a Vercel provider, so delivery verification talks to the same endpoint. */
export function readVercelScheduleClientOptions(
  provider: ScheduleProvider,
): VercelScheduleProviderOptions | undefined {
  return CLIENT_OPTIONS.get(provider);
}

export interface VercelScheduleProviderOptions {
  /** Overrides the public Vercel Schedules endpoint. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/** Uses ambient OIDC on Vercel and process-local storage under `eve dev`. */
export function vercelScheduleProvider(
  options: VercelScheduleProviderOptions = {},
): ScheduleProvider {
  if (isEveDevEnvironment()) return DEVELOPMENT_PROVIDER;

  const client = (signal: AbortSignal) => createClient(options, signal);

  const provider: ScheduleProvider = {
    kind: "vercel",
    async create(context, input) {
      const schedules = await client(context.abortSignal);
      let schedule: VercelSchedule = await schedules.create({
        expression: toVercelExpression(input.expression),
        jitter: input.expression.type === "cron" ? input.expression.jitter : undefined,
        name: input.name,
        namespace: context.namespace,
        payload: createDispatchPayload(context, input.payload),
        target: { topic: deriveEveScheduleQueueTopic(context.target.key) },
        timezone: input.expression.timezone,
      });
      if (input.state === "inactive") {
        try {
          schedule = await schedules.disable({ name: input.name, namespace: context.namespace });
        } catch (error) {
          throw new Error(
            `Schedule ${JSON.stringify(input.name)} was created active, but disabling it failed; it may remain active.`,
            { cause: error },
          );
        }
      }
      return fromVercelSchedule(schedule);
    },
    async list(context, input): Promise<SchedulePage> {
      const cursor = input.cursor?.trim() || undefined;
      const params: { namespace: string; cursor?: string; limit?: number } = {
        namespace: context.namespace,
      };
      if (cursor !== undefined) params.cursor = cursor;
      if (input.limit !== undefined) params.limit = input.limit;
      const page = await (await client(context.abortSignal)).list(params);
      return { cursor: page.cursor, data: page.data.map(fromVercelSchedule) };
    },
    async get(context, name) {
      const response = await getScheduleOrNull(
        await client(context.abortSignal),
        name,
        context.namespace,
      );
      return response === null ? null : fromVercelSchedule(response);
    },
    async enable(context, name) {
      return fromVercelSchedule(
        await (await client(context.abortSignal)).enable({ name, namespace: context.namespace }),
      );
    },
    async disable(context, name) {
      return fromVercelSchedule(
        await (await client(context.abortSignal)).disable({ name, namespace: context.namespace }),
      );
    },
    async invoke(context, name) {
      await (await client(context.abortSignal)).invoke({ name, namespace: context.namespace });
    },
    async delete(context, name) {
      try {
        await (await client(context.abortSignal)).delete({ name, namespace: context.namespace });
        return true;
      } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
      }
    },
  };
  CLIENT_OPTIONS.set(provider, options);
  return provider;
}

async function createClient(
  options: VercelScheduleProviderOptions,
  signal: AbortSignal,
): Promise<SchedulesClient> {
  assertSupportedVercelEnvironment();
  const { SchedulesClient } = await import("#compiled/@vercel/schedules/index.js");
  signal.throwIfAborted();
  const fetchImpl = options.fetch ?? fetch;
  return new SchedulesClient({
    ...options,
    fetch: (input, init) => fetchImpl(input, { ...init, signal }),
  });
}

function createDispatchPayload(context: ScheduleProviderContext, payload: unknown) {
  return {
    eve: {
      application: context.target.key,
      collection: context.collection,
      version: 1,
    },
    payload,
  };
}

function toVercelExpression(expression: ScheduleExpression) {
  return expression.type === "cron"
    ? { type: "cron" as const, cron: expression.cron }
    : { type: "single" as const, at: expression.at };
}

function fromVercelSchedule(schedule: VercelSchedule): ScheduleRecord {
  let expression: ScheduleExpression;
  if (schedule.expression.type === "cron") {
    const cron: { type: "cron"; cron: string; timezone: string; jitter?: number } = {
      type: "cron",
      cron: schedule.expression.cron,
      timezone: schedule.timezone,
    };
    if (schedule.jitter !== undefined) cron.jitter = schedule.jitter;
    expression = cron;
  } else {
    expression = { type: "single", at: schedule.expression.at, timezone: schedule.timezone };
  }
  return {
    createdAt: schedule.createdAt,
    expression,
    name: schedule.name,
    scheduleId: schedule.scheduleId,
    state: schedule.state,
    updatedAt: schedule.updatedAt,
  };
}

async function getScheduleOrNull(
  client: SchedulesClient,
  name: string,
  namespace: string,
): Promise<VercelSchedule | null> {
  try {
    return await client.get({ name, namespace });
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "name") === "SchedulesApiError" &&
    Reflect.get(error, "status") === 404
  );
}

function assertSupportedVercelEnvironment(): void {
  if (!process.env.VERCEL?.trim()) {
    throw new Error("vercelScheduleProvider() requires a Vercel production deployment or eve dev.");
  }
  if (process.env.VERCEL_ENV !== "production") {
    throw new Error(
      "Vercel Schedules currently supports production deployments only. Deploy with `vercel --prod`.",
    );
  }
}
