import type { Schedule as VercelSchedule, SchedulesClient } from "@vercel/schedules";

import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import type {
  ScheduleExpression,
  SchedulePage,
  ScheduleProvider,
  ScheduleProviderContext,
  ScheduleRecord,
} from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

const DEVELOPMENT_PROVIDER = inMemoryScheduleProvider();

export interface VercelScheduleProviderOptions {
  /** Overrides the public Vercel Schedules endpoint. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Local-development workaround for production control-plane testing. Prefer ambient OIDC on Vercel. */
  readonly developmentBearerToken?: string;
  /** Project ID required with `developmentBearerToken`. */
  readonly developmentProjectId?: string;
}

/**
 * Uses the official Vercel Schedules SDK with ambient OIDC in deployed
 * production and process-local storage under `eve dev`. A personal bearer token
 * may opt `eve dev` into production control-plane testing.
 */
export function vercelScheduleProvider(
  options: VercelScheduleProviderOptions = {},
): ScheduleProvider {
  const developmentBearerToken = options.developmentBearerToken?.trim();
  const developmentProjectId = options.developmentProjectId?.trim();
  const useDevelopmentBearer =
    developmentBearerToken !== undefined && developmentBearerToken.length > 0;
  if (useDevelopmentBearer && !isEveDevEnvironment()) {
    throw new Error(
      "vercelScheduleProvider() developmentBearerToken is available only under eve dev. Vercel deployments use ambient OIDC.",
    );
  }
  if (useDevelopmentBearer && !developmentProjectId) {
    throw new Error(
      "vercelScheduleProvider() developmentBearerToken requires developmentProjectId.",
    );
  }
  if (isEveDevEnvironment() && !useDevelopmentBearer) return DEVELOPMENT_PROVIDER;

  let clientPromise: Promise<SchedulesClient> | undefined;
  const client = () =>
    (clientPromise ??= createClient({
      baseUrl: options.baseUrl,
      bearerToken: developmentBearerToken,
      fetch: options.fetch,
      projectId: developmentProjectId,
    }));

  return {
    kind: "vercel",
    async create(context, input) {
      const schedules = await client();
      let schedule = await schedules.create({
        expression: toVercelExpression(input.expression),
        jitter: input.expression.type === "cron" ? input.expression.jitter : undefined,
        name: input.name,
        namespace: context.namespace,
        payload: createDispatchPayload(context, input.input),
        target: { topic: deriveEveScheduleQueueTopic(context.target.key) },
        timezone: input.expression.timezone,
      });
      if (input.state === "inactive") {
        schedule = await schedules.disable({ name: input.name, namespace: context.namespace });
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
      const page = await (await client()).list(params);
      return { cursor: page.cursor, data: page.data.map(fromVercelSchedule) };
    },
    async get(context, name) {
      const response = await getScheduleOrNull(await client(), name, context.namespace);
      return response === null ? null : fromVercelSchedule(response);
    },
    async update(context, name, patch) {
      const schedules = await client();
      const params: Parameters<SchedulesClient["update"]>[0] = {
        name,
        namespace: context.namespace,
      };
      if (patch.expression !== undefined) {
        params.expression = toVercelExpression(patch.expression);
        params.timezone = patch.expression.timezone;
        if (patch.expression.type === "cron") params.jitter = patch.expression.jitter;
      }
      if (patch.input !== undefined) params.payload = createDispatchPayload(context, patch.input);
      return fromVercelSchedule(await schedules.update(params));
    },
    async enable(context, name) {
      return fromVercelSchedule(
        await (await client()).enable({ name, namespace: context.namespace }),
      );
    },
    async disable(context, name) {
      return fromVercelSchedule(
        await (await client()).disable({ name, namespace: context.namespace }),
      );
    },
    async invoke(context, name) {
      await (await client()).invoke({ name, namespace: context.namespace });
    },
    async delete(context, name) {
      const schedules = await client();
      if ((await getScheduleOrNull(schedules, name, context.namespace)) === null) return false;
      await schedules.delete({ name, namespace: context.namespace });
      return true;
    },
  };
}

async function createClient(input: {
  readonly baseUrl?: string;
  readonly bearerToken?: string;
  readonly fetch?: typeof fetch;
  readonly projectId?: string;
}): Promise<SchedulesClient> {
  assertSupportedVercelEnvironment(input.bearerToken !== undefined);
  const { SchedulesClient } = await import("@vercel/schedules");
  const fetchImpl =
    input.bearerToken === undefined
      ? input.fetch
      : withProjectId(input.fetch ?? fetch, input.projectId!);
  const options: ConstructorParameters<typeof SchedulesClient>[0] = {};
  if (input.baseUrl !== undefined) options.baseUrl = input.baseUrl;
  if (fetchImpl !== undefined) options.fetch = fetchImpl;
  if (input.bearerToken !== undefined) options.token = input.bearerToken;
  return new SchedulesClient(options);
}

function withProjectId(fetchImpl: typeof fetch, projectId: string): typeof fetch {
  return async (resource, init) => {
    const url = new URL(
      typeof resource === "string" || resource instanceof URL ? resource : resource.url,
    );
    url.searchParams.set("projectId", projectId);
    return await fetchImpl(url, init);
  };
}

function createDispatchPayload(context: ScheduleProviderContext, input: unknown) {
  return {
    eve: {
      application: context.target.key,
      collection: context.collection,
      version: 1,
    },
    input,
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

function assertSupportedVercelEnvironment(useDevelopmentBearer: boolean): void {
  if (useDevelopmentBearer && isEveDevEnvironment()) return;
  if (!process.env.VERCEL?.trim()) {
    throw new Error("vercelScheduleProvider() requires a Vercel production deployment or eve dev.");
  }
  if (process.env.VERCEL_ENV !== "production") {
    throw new Error(
      "Vercel Schedules currently supports production deployments only. Deploy with `vercel --prod`.",
    );
  }
}
