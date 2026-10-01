import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_SENTINEL,
  type CompiledChannel,
  isCompiledChannel,
} from "#channel/compiled-channel.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import {
  SCHEDULE_ADAPTER,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_APP_AUTH,
  ScheduleDispatcher,
} from "#channel/schedule.js";
import { contextStorage } from "#context/container.js";
import { ScheduleIdKey } from "#context/keys.js";
import type { RunHandle, Runtime, SessionAuthContext } from "#channel/types.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import { isScheduleAuth } from "#public/schedules/index.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import { defineScheduleCollection } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { createScheduleCollectionPayload } from "#runtime/schedules/payload.js";

function createMockRunHandle(): RunHandle {
  return { events: new ReadableStream<MessageStreamEvent>(), sessionId: "mock-session-id" };
}
function createMockRuntime(): Runtime {
  return {
    createSession: vi.fn().mockResolvedValue(createMockRunHandle()),
    dispatchContinuation: vi.fn().mockResolvedValue({ status: "session_not_active" }),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream<MessageStreamEvent>()),
    getStreamTailIndex: vi.fn().mockResolvedValue(-1),
    resolveContinuation: vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ sessionId: "mock-session-id" }),
  };
}
function makeSlackChannelEntry(): {
  definition: CompiledChannel;
  resolved: ResolvedChannelDefinition;
} {
  const channel = slackChannel();
  if (!isCompiledChannel(channel))
    throw new Error("expected a compiled slack channel for this test");
  return {
    definition: channel,
    resolved: {
      name: "slack",
      method: "POST",
      urlPath: "/eve/v1/slack",
      logicalPath: "channels/slack.ts",
      sourceId: "channel-slack",
      sourceKind: "module",
      adapter: channel.adapter,
      definition: channel,
      receive: channel.receive,
      fetch: async () => new Response("ok"),
    },
  };
}

describe("ScheduleDispatcher", () => {
  describe("collection form", () => {
    const creator = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };
    const deliver = async () => {};
    const occurrence = {
      collection: "requests",
      executionId: "exec-1",
      name: "weekly",
      scheduleId: "sch-1",
      scheduledAt: "2026-09-29T19:00:00Z",
    };
    function trigger(stored: string[], configured = stored, auth: typeof creator | null = creator) {
      const runtime = createMockRuntime();
      const definition = defineScheduleCollection({
        provider: inMemoryScheduleProvider(),
        auth: () => auth,
        deliveries: Object.fromEntries(
          configured.map((name) => [name, { description: `Send to ${name}.`, deliver }]),
        ),
      });
      const payload = createScheduleCollectionPayload({
        application: "fixture",
        collection: "requests",
        envelope: {
          version: 2,
          request: "Summarize the week.",
          scope: "alice",
          principal: { type: "user", authenticator: "test", principalId: "alice" },
          metadata: {},
          deliveries: Object.fromEntries(stored.map((name) => [name, {}])),
        },
      });
      const result = new ScheduleDispatcher({ runtime, channels: [] }).triggerCollection({
        collectionId: "requests",
        definition,
        namespace: "eve-namespace",
        occurrence,
        payload,
        scheduleName: "weekly",
      });
      return { result, runtime };
    }

    // Regression: channel-less occurrences omitted occurrenceToken, so admission always failed.
    it.each([
      [["thread"], undefined],
      [
        ["archive", "sms"],
        ["archive", "sms"],
      ],
    ])(
      "admits %j under the occurrence's create-once identity as the creator",
      async (deliveries, schemaKeys) => {
        const { result, runtime } = trigger(deliveries);
        await result;
        const run = vi.mocked(runtime.createSession).mock.calls[0]![0];
        expect(run.occurrenceToken).toBeDefined();
        expect(run.occurrenceToken).toBe(run.continuationToken);
        expect(run.auth?.attributes["eve.scheduled_run"]).toBe("true");
        expect(run.capabilities).toEqual({ requestInput: false });
        expect(run.input.outputSchema?.required).toEqual(schemaKeys);
      },
    );

    it.each([
      [
        "a stored delivery is no longer configured",
        ["sms"],
        ["thread"],
        creator,
        'Scheduled delivery "sms" is no longer configured.',
      ],
      [
        "the creator is no longer authorized",
        ["thread"],
        ["thread"],
        null,
        "Scheduled execution is no longer authorized.",
      ],
    ] as const)("starts no session when %s", async (_label, stored, configured, auth, message) => {
      const { result, runtime } = trigger([...stored], [...configured], auth);
      await expect(result).rejects.toThrow(message);
      expect(runtime.createSession).not.toHaveBeenCalled();
    });
  });

  describe("markdown form", () => {
    it("starts a Session via runtime.createSession with the SCHEDULE_ADAPTER", async () => {
      const runtime = createMockRuntime();
      const dispatcher = new ScheduleDispatcher({ runtime, channels: [] });
      const result = await dispatcher.trigger({
        scheduleId: "heartbeat",
        markdown: "Run heartbeat task.",
      });
      expect(runtime.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: SCHEDULE_ADAPTER,
          input: { message: "Run heartbeat task." },
          auth: SCHEDULE_APP_AUTH,
        }),
      );
      expect(SCHEDULE_ADAPTER.kind).toBe(SCHEDULE_ADAPTER_KIND);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]!.id).toBe("mock-session-id");
      expect(result.waitUntilTasks).toHaveLength(0);
    });
    it("propagates runtime.createSession failures", async () => {
      const runtime = createMockRuntime();
      runtime.createSession = vi.fn().mockRejectedValue(new Error("boom"));
      await expect(
        new ScheduleDispatcher({ runtime, channels: [] }).trigger({
          scheduleId: "heartbeat",
          markdown: "x",
        }),
      ).rejects.toThrow("boom");
    });
  });

  describe("run handler form", () => {
    it("invokes run() with { to, waitUntil, appAuth }", async () => {
      const runtime = createMockRuntime();
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
      vi.stubEnv("SLACK_SIGNING_SECRET", "test-secret");
      try {
        const { definition, resolved } = makeSlackChannelEntry();
        const dispatcher = new ScheduleDispatcher({ runtime, channels: [resolved] });
        let observed = false;
        const result = await dispatcher.trigger({
          scheduleId: "daily-digest",
          async run({ to, waitUntil, appAuth }) {
            observed = appAuth.principalId === "eve:app" && typeof waitUntil === "function";
            await to(definition, { channelId: "C0123ABC" }).send("post the digest", {
              auth: appAuth,
            });
          },
        });
        expect(observed).toBe(true);
        expect(result.sessions).toHaveLength(1);
        expect(runtime.createSession).toHaveBeenCalledTimes(1);
        const run = vi.mocked(runtime.createSession).mock.calls[0]![0];
        expect(run.auth).toEqual(SCHEDULE_APP_AUTH);
        // A threadless destination needs a fresh conversation per dispatch.
        expect(run.continuationToken).toMatch(
          /^slack:C0123ABC:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it("collects waitUntil promises", async () => {
      const runtime = createMockRuntime();
      const result = await new ScheduleDispatcher({ runtime, channels: [] }).trigger({
        scheduleId: "background-job",
        async run({ waitUntil }) {
          waitUntil(Promise.resolve("done"));
          waitUntil(Promise.resolve(42));
        },
      });
      expect(result.waitUntilTasks).toHaveLength(2);
      await expect(Promise.all(result.waitUntilTasks)).resolves.toEqual(["done", 42]);
      expect(result.sessions).toHaveLength(0);
    });
    it("scopes user-auth sessions started through waitUntil to the active schedule", async () => {
      const runtime = createMockRuntime();
      const observed: Array<string | undefined> = [];
      runtime.createSession = vi.fn(async () => {
        observed.push(contextStorage.getStore()?.get(ScheduleIdKey));
        return createMockRunHandle();
      });
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
      vi.stubEnv("SLACK_SIGNING_SECRET", "test-secret");
      try {
        const { definition, resolved } = makeSlackChannelEntry();
        const result = await new ScheduleDispatcher({ runtime, channels: [resolved] }).trigger({
          scheduleId: "dynamic-tasks",
          run({ to, waitUntil }) {
            waitUntil(
              Promise.resolve().then(() =>
                to(definition, { channelId: "C0123ABC" }).send("run", {
                  auth: {
                    attributes: {},
                    authenticator: "slack",
                    principalId: "owner",
                    principalType: "user",
                  },
                }),
              ),
            );
          },
        });
        await Promise.all(result.waitUntilTasks);
        expect(observed).toEqual(["dynamic-tasks"]);
        expect(contextStorage.getStore()?.get(ScheduleIdKey)).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it("rejects unregistered channels", async () => {
      const stranger = {
        __kind: CHANNEL_SENTINEL,
        routes: [],
        adapter: { kind: "x" },
      } satisfies CompiledChannel;
      await expect(
        new ScheduleDispatcher({ runtime: createMockRuntime(), channels: [] }).trigger({
          scheduleId: "stranger",
          async run({ to }) {
            await to(stranger, {}).send("x", { auth: null });
          },
        }),
      ).rejects.toThrow(/not registered in this agent/);
    });
  });

  it("isScheduleAuth recognizes the app principal schedules dispatch with, and only it", async () => {
    const runtime = createMockRuntime();
    const dispatcher = new ScheduleDispatcher({ runtime, channels: [] });
    let appAuth: SessionAuthContext | undefined;

    await dispatcher.trigger({ scheduleId: "heartbeat", markdown: "Run heartbeat task." });
    await dispatcher.trigger({
      scheduleId: "digest",
      async run(args) {
        appAuth = args.appAuth;
      },
    });

    expect(isScheduleAuth(vi.mocked(runtime.createSession).mock.calls[0]![0].auth)).toBe(true);
    expect(isScheduleAuth(appAuth)).toBe(true);
    const alice: SessionAuthContext = {
      attributes: {},
      authenticator: "okta",
      principalId: "okta|alice",
      principalType: "user",
    };
    expect(isScheduleAuth(alice)).toBe(false);
    expect(isScheduleAuth({ ...alice, principalId: "eve:app" })).toBe(false);
    expect(isScheduleAuth(null)).toBe(false);
  });

  it("throws when neither run nor markdown is provided", async () => {
    await expect(
      new ScheduleDispatcher({ runtime: createMockRuntime(), channels: [] }).trigger({
        scheduleId: "empty",
      }),
    ).rejects.toThrow(/has neither "run" nor "markdown"/);
  });
});
