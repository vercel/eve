import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";

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

const DEFAULT_BASE_URL = "https://vss-server.vercel.sh";
const DEVELOPMENT_PROVIDER = inMemoryScheduleProvider();

export interface VercelScheduleProviderOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Explicit Vercel OIDC token. Supplying one opts local development into the remote control plane. */
  readonly token?: string;
}

interface VercelSchedule {
  readonly createdAt: number;
  readonly expression:
    | { readonly type: "cron"; readonly cron: string }
    | {
        readonly type: "single";
        readonly at: string;
      };
  readonly jitter?: number;
  readonly name: string;
  readonly scheduleId: string;
  readonly state: "active" | "inactive";
  readonly timezone: string;
  readonly updatedAt: number;
}

/**
 * Uses Vercel Schedules in deployed production and process-local storage under
 * `eve dev`. Preview and non-Vercel production environments fail closed.
 */
export function vercelScheduleProvider(
  options: VercelScheduleProviderOptions = {},
): ScheduleProvider {
  const explicitToken = options.token?.trim();
  const useRemoteControlPlane = explicitToken !== undefined && explicitToken.length > 0;
  if (isEveDevEnvironment() && !useRemoteControlPlane) return DEVELOPMENT_PROVIDER;

  const baseUrl = new URL(
    options.baseUrl ?? process.env.VERCEL_SCHEDULE_BASE_URL ?? DEFAULT_BASE_URL,
  );
  const fetchImpl = options.fetch ?? fetch;
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    assertSupportedVercelEnvironment(useRemoteControlPlane);
    const token = explicitToken || (await getVercelOidcToken());
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetchImpl(new URL(path, baseUrl), {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(
        `Vercel Schedules request failed (${response.status})${detail ? `: ${detail}` : "."}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };

  return {
    kind: "vercel",
    async create(context, input) {
      const schedule = await request<VercelSchedule>("POST", "/v1/schedules", {
        expression: toVercelExpression(input.expression),
        jitter: input.expression.type === "cron" ? input.expression.jitter : undefined,
        name: input.name,
        namespace: context.namespace,
        payload: createDispatchPayload(context, input.input),
        target: { type: "queue", topic: deriveEveScheduleQueueTopic(context.target.key) },
        timezone: input.expression.timezone,
      });
      if (input.state === "inactive") {
        return fromVercelSchedule(
          await request<VercelSchedule>(
            "POST",
            schedulePath(input.name, context.namespace, "/disable"),
          ),
        );
      }
      return fromVercelSchedule(schedule);
    },
    async list(context, input): Promise<SchedulePage> {
      const search = new URLSearchParams({ namespace: context.namespace });
      const cursor = input.cursor?.trim();
      if (cursor) search.set("cursor", cursor);
      if (input.limit !== undefined) search.set("limit", String(input.limit));
      const page = await request<{ data: VercelSchedule[]; cursor: string | null }>(
        "GET",
        `/v1/schedules?${search.toString()}`,
      );
      return { cursor: page.cursor, data: page.data.map(fromVercelSchedule) };
    },
    async get(context, name) {
      const response = await fetchScheduleOrNull(request, name, context.namespace);
      return response === null ? null : fromVercelSchedule(response);
    },
    async update(context, name, patch) {
      const body: Record<string, unknown> = {};
      if (patch.expression !== undefined) {
        body.expression = toVercelExpression(patch.expression);
        body.timezone = patch.expression.timezone;
        if (patch.expression.type === "cron") body.jitter = patch.expression.jitter;
      }
      if (patch.input !== undefined) body.payload = createDispatchPayload(context, patch.input);
      return fromVercelSchedule(
        await request<VercelSchedule>("PATCH", schedulePath(name, context.namespace), body),
      );
    },
    async enable(context, name) {
      return fromVercelSchedule(
        await request<VercelSchedule>("POST", schedulePath(name, context.namespace, "/enable")),
      );
    },
    async disable(context, name) {
      return fromVercelSchedule(
        await request<VercelSchedule>("POST", schedulePath(name, context.namespace, "/disable")),
      );
    },
    async invoke(context, name) {
      await request("POST", schedulePath(name, context.namespace, "/invoke"));
    },
    async delete(context, name) {
      const existing = await fetchScheduleOrNull(request, name, context.namespace);
      if (existing === null) return false;
      await request("DELETE", schedulePath(name, context.namespace));
      return true;
    },
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
  const expression: ScheduleExpression =
    schedule.expression.type === "cron"
      ? {
          type: "cron",
          cron: schedule.expression.cron,
          timezone: schedule.timezone,
          ...(schedule.jitter === undefined ? {} : { jitter: schedule.jitter }),
        }
      : { type: "single", at: schedule.expression.at, timezone: schedule.timezone };
  return {
    createdAt: schedule.createdAt,
    expression,
    name: schedule.name,
    scheduleId: schedule.scheduleId,
    state: schedule.state,
    updatedAt: schedule.updatedAt,
  };
}

async function fetchScheduleOrNull(
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>,
  name: string,
  namespace: string,
): Promise<VercelSchedule | null> {
  try {
    return await request("GET", schedulePath(name, namespace));
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) return null;
    throw error;
  }
}

function schedulePath(name: string, namespace: string, suffix = ""): string {
  const search = new URLSearchParams({ namespace });
  return `/v1/schedules/${encodeURIComponent(name)}${suffix}?${search.toString()}`;
}

function assertSupportedVercelEnvironment(useRemoteControlPlane: boolean): void {
  if (useRemoteControlPlane && isEveDevEnvironment()) return;
  if (!process.env.VERCEL?.trim()) {
    throw new Error("vercelScheduleProvider() requires a Vercel production deployment or eve dev.");
  }
  if (process.env.VERCEL_ENV !== "production") {
    throw new Error(
      "Vercel Schedules currently supports production deployments only. Deploy with `vercel --prod`.",
    );
  }
}
