import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleDelivery, ScheduleProviderContext } from "#public/schedules/collection.js";
import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { bindScheduleCollection } from "#runtime/schedules/collection-client.js";
import { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";
import { handleScheduleCollectionConsumer } from "#internal/nitro/routes/schedule-collection-consumer.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  load: vi.fn(),
  createSession: vi.fn(),
}));
vi.mock("@vercel/queue", () => ({
  handleCallback:
    (
      callback: (value: unknown, metadata: unknown) => Promise<void>,
      options: { retry(error: unknown): unknown },
    ) =>
    async (request: Request) => {
      try {
        await callback(await request.json(), {
          topicName: "__topic__",
          messageId: "message_1",
          createdAt: new Date("2026-09-25T12:00:00Z"),
        });
        return new Response(null, { status: 200 });
      } catch (error) {
        if (options.retry(error)) return new Response(null, { status: 204 });
        throw error;
      }
    },
}));
vi.mock("@vercel/schedules", () => ({
  SchedulesClient: class {
    get = mocks.get;
  },
  SchedulesApiError: class extends Error {},
}));
vi.mock("#runtime/schedules/queue-namespace.js", () => ({
  deriveEveScheduleQueueTopic: () => "__topic__",
}));
vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: () => ({}),
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async () => ({ graph: { root: { channels: [] } }, moduleMap: {} }),
}));
vi.mock("#runtime/loaders/manifest.js", () => ({
  loadCompiledManifest: async () => ({
    config: { name: "fixture" },
    scheduleCollections: [{ name: "tasks", providerKind: "vercel" }],
  }),
}));
vi.mock("#runtime/resolve-helpers.js", () => ({ loadResolvedModuleExport: mocks.load }));
vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: () => ({ createSession: mocks.createSession }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSession.mockResolvedValue({ sessionId: "occurrence-session" });
});

async function savedOccurrence(runAs: "creator" | "app") {
  const definition = defineScheduleCollection({
    provider: inMemoryScheduleProvider(),
    scope: "shared",
    runAs,
  });
  let providerContext: ScheduleProviderContext | undefined;
  const create = definition.provider.create.bind(definition.provider);
  definition.provider.create = async (context, input) => {
    providerContext = context;
    return await create(context, input);
  };
  let delivered: ScheduleDelivery | undefined;
  const caller = {
    attributes: { team_id: "team" },
    authenticator: "slack-webhook",
    issuer: "slack:team",
    principalType: "user",
    principalId: "alice",
  };
  const client = await bindScheduleCollection(
    "tasks",
    definition,
    {
      application: "fixture",
      targetKey: "fixture",
      abortSignal: new AbortController().signal,
      session: { id: "origin-session", auth: { current: caller, initiator: null } },
      channel: { kind: "slack", continuationToken: "thread" },
    },
    async (delivery) => {
      delivered = delivery;
    },
  );
  const record = await client!.create({
    name: "daily",
    payload: "Review incidents",
    expression: { type: "cron", cron: "0 9 * * *" },
  });
  await client!.invoke("daily");
  mocks.load.mockResolvedValue(definition);
  const resource = {
    ...record,
    namespace: providerContext!.namespace,
    source: "dynamic",
    target: { type: "queue", topic: deriveEveScheduleQueueTopic("fixture") },
  };
  mocks.get.mockResolvedValue(resource);
  return {
    definition,
    caller,
    message: {
      ...resource,
      executionId: "occurrence_1",
      scheduledAt: "2026-09-25T12:00:00Z",
      payload: {
        eve: { application: "fixture", collection: "tasks", version: 1 },
        payload: delivered!.payload,
      },
    },
  };
}

async function consume(message: unknown) {
  return await handleScheduleCollectionConsumer(
    {} as never,
    new Request("https://fixture.example/consumer", {
      method: "POST",
      body: JSON.stringify(message),
    }),
  );
}

describe("schedule collection admission identity", () => {
  it.each(["creator", "app"] as const)(
    "restores the %s policy after a provider payload round trip",
    async (runAs) => {
      const { message, caller } = await savedOccurrence(runAs);
      const response = await consume(message);
      expect(response.status).toBe(200);
      expect(mocks.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: runAs === "creator" ? caller : SCHEDULE_APP_AUTH,
          input: { message: expect.stringContaining("Review incidents") },
        }),
      );
    },
  );

  it("acknowledges obsolete execution policies without creating a session", async () => {
    const { definition, message } = await savedOccurrence("creator");
    mocks.load.mockResolvedValue({ ...definition, runAs: "app" });
    expect((await consume(message)).status).toBe(204);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("acknowledges legacy payloads without restoring any identity", async () => {
    const { message } = await savedOccurrence("creator");
    message.payload.payload = "legacy request";
    expect((await consume(message)).status).toBe(204);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
