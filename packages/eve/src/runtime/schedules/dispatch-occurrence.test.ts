import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "#compiled/zod/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { vercelScheduleProvider } from "#public/schedules/providers/vercel.js";
import {
  defineDynamicSchedules,
  type DynamicSchedulesRunArgs,
  type ScheduleOperation,
  type ScheduleProvider,
} from "#public/schedules/subscription.js";
import {
  createScheduleCollectionClient,
  type ScheduleBoundCallContext,
} from "#runtime/schedules/collection-client.js";
import { dispatchScheduledOccurrence } from "#runtime/schedules/dispatch-occurrence.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const bundle = { compiledArtifactsSource: {}, graph: { root: { channels: [] } } } as never;
const callContext: ScheduleBoundCallContext = {
  abortSignal: new AbortController().signal,
  application: "fixture",
  collection: "requests",
  channel: { kind: "unknown", metadata: {} },
  session: {
    id: "session-alice",
    auth: {
      current: {
        attributes: {},
        authenticator: "test",
        principalId: "alice",
        principalType: "user",
      },
      initiator: null,
    },
  },
};
const expression = { type: "cron" as const, cron: "0 9 * * *" };

function setup(
  provider: ScheduleProvider,
  run: (args: DynamicSchedulesRunArgs<{ task: string }>) => Promise<void>,
) {
  const scope = vi.fn((_context: { readonly operation: ScheduleOperation }) => ["team", "billing"]);
  const definition = defineDynamicSchedules({
    provider,
    tool: false,
    inputSchema: z.object({ task: z.string() }).strict(),
    scope,
    auth: () => ({ attributes: {} }),
    run,
  });
  return { client: createScheduleCollectionClient(definition, callContext), definition, scope };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the schedule handle an occurrence callback receives", () => {
  it.each([
    ["disable", { state: "inactive" }],
    ["delete", null],
  ] as const)(
    "%ss only the schedule that fired, without asking scope",
    async (operation, expected) => {
      const { client, scope } = setup(
        inMemoryScheduleProvider(),
        async ({ schedule }) => await schedule[operation](),
      );
      const fired = await client.create({ name: "fired", expression, payload: { task: "a" } });
      const other = await client.create({ name: "other", expression, payload: { task: "b" } });
      const context = new ContextContainer();
      context.set(BundleKey, bundle);
      scope.mockClear();

      await contextStorage.run(context, () => client.invoke(fired.name));

      expect(scope.mock.calls.map(([call]) => call.operation)).toEqual(["invoke"]);
      const after = await client.get(fired.name);
      if (expected === null) expect(after).toBeNull();
      else expect(after).toMatchObject(expected);
      await expect(client.get(other.name)).resolves.toMatchObject({ state: "active" });
    },
  );

  it("addresses the Vercel schedule in the namespace its creator wrote it to", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv(
      "VERCEL_OIDC_TOKEN",
      `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString("base64url")}.signature`,
    );
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
      Response.json({
        createdAt: 1,
        expression,
        name: "fired",
        scheduleId: "sch_1",
        state: "active",
        timezone: "UTC",
        updatedAt: 2,
        ...(init?.body ? { name: JSON.parse(String(init.body)).name } : {}),
      }),
    );
    const { client, definition } = setup(
      vercelScheduleProvider({ fetch: fetchImpl }),
      async ({ schedule }) => {
        await schedule.disable();
        await schedule.delete();
      },
    );
    const created = await client.create({ name: "fired", expression, payload: { task: "a" } });
    const stored = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));

    await dispatchScheduledOccurrence({
      bundle,
      collection: "requests",
      definition,
      occurrence: {
        collection: "requests",
        executionId: "exec-1",
        name: created.name,
        scheduleId: created.scheduleId,
        scheduledAt: "2026-09-29T19:00:00Z",
      },
      payload: stored.payload.payload,
    });

    const requests = fetchImpl.mock.calls.slice(1).map(([url, init]) => {
      const { pathname, searchParams } = new URL(String(url));
      return { method: init?.method, pathname, namespace: searchParams.get("namespace") };
    });
    expect(requests).toEqual([
      {
        method: "POST",
        pathname: `/v1/schedules/${created.name}/disable`,
        namespace: stored.namespace,
      },
      { method: "DELETE", pathname: `/v1/schedules/${created.name}`, namespace: stored.namespace },
    ]);
  });
});
