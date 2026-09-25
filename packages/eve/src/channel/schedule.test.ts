import { describe, expect, it, vi } from "vitest";

import { CHANNEL_SENTINEL, type CompiledChannel } from "#channel/compiled-channel.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import {
  SCHEDULE_ADAPTER,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_APP_AUTH,
  ScheduleDispatcher,
} from "#channel/schedule.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { contextStorage } from "#context/container.js";
import {
  ScheduleIdKey,
  ScheduleOriginKey,
  AuthKey,
  InitiatorAuthKey,
  TaskDeliveryPolicyKey,
} from "#context/keys.js";
import { createSchedulePayload } from "#runtime/schedules/payload.js";
import type { RunHandle, Runtime } from "#channel/types.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

function createMockRunHandle(): RunHandle {
  return {
    events: new ReadableStream<MessageStreamEvent>(),
    sessionId: "mock-session-id",
  };
}

function createMockRuntime(): Runtime {
  return {
    createSession: vi.fn().mockResolvedValue(createMockRunHandle()),
    dispatchContinuation: vi.fn().mockResolvedValue({ status: "session_not_active" }),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream<MessageStreamEvent>()),
    getStreamTailIndex: vi.fn().mockResolvedValue(-1),
    resolveContinuation: vi.fn(),
  };
}

function makeSlackChannelEntry(): {
  definition: CompiledChannel;
  resolved: ResolvedChannelDefinition;
} {
  const channel = slackChannel();
  if (!isCompiledChannel(channel)) {
    throw new Error("expected a compiled slack channel for this test");
  }
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
  it.each([undefined, "auto", "cohort"] as const)(
    "uses the schedule default unless send supplies %s",
    async (taskDeliveryPolicy) => {
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
      vi.stubEnv("SLACK_SIGNING_SECRET", "test-secret");
      try {
        const runtime = createMockRuntime();
        const policies: unknown[] = [];
        runtime.createSession = vi.fn(async (run) => {
          policies.push(buildRunContext({ bundle: {} as never, run }).get(TaskDeliveryPolicyKey));
          return createMockRunHandle();
        });
        const { definition, resolved } = makeSlackChannelEntry();
        const result = await new ScheduleDispatcher({ runtime, channels: [resolved] }).trigger({
          scheduleId: "daily-report",
          run({ to, waitUntil, appAuth }) {
            waitUntil(
              Promise.resolve().then(() =>
                to(definition, { channelId: "C0123ABC" }).send("Report", {
                  auth: appAuth,
                  taskDeliveryPolicy,
                }),
              ),
            );
          },
        });
        await Promise.all(result.waitUntilTasks);
        expect(policies).toEqual([taskDeliveryPolicy ?? "cohort"]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  describe("collection form", () => {
    const creator = {
      attributes: { user_id: "alice" },
      authenticator: "slack-webhook",
      principalId: "alice",
      principalType: "user",
    };
    const initiator = { ...creator, principalId: "bob" };
    const payload = (runAs: "creator" | "app") =>
      createSchedulePayload({
        request: "Review open incidents",
        runAs,
        binding: {
          application: "fixture",
          collection: "queries",
          namespace: "eve-test",
          name: "weekly-incidents",
        },
        context: {
          abortSignal: new AbortController().signal,
          channel: { kind: "slack" },
          session: { id: "origin", auth: { current: creator, initiator } },
        },
      });

    it.each(["creator", "app"] as const)(
      "restores %s execution identity independently of origin",
      async (runAs) => {
        const runtime = createMockRuntime();
        runtime.createSession = vi.fn(async (run) => {
          const ctx = buildRunContext({ bundle: {} as never, run });
          expect(ctx.get(AuthKey)).toEqual(runAs === "creator" ? creator : SCHEDULE_APP_AUTH);
          expect(ctx.get(InitiatorAuthKey)).toEqual(
            runAs === "creator" ? initiator : SCHEDULE_APP_AUTH,
          );
          expect(ctx.get(ScheduleOriginKey)?.auth.current).toEqual(creator);
          expect(ctx.get(ScheduleOriginKey)?.sessionId).toBe("origin");
          expect(run).not.toHaveProperty("parent");
          expect(run).not.toHaveProperty("continuationToken");
          return createMockRunHandle();
        });
        await new ScheduleDispatcher({ runtime, channels: [] }).triggerCollection({
          collectionId: "queries",
          payload: payload(runAs),
          occurrence: {
            executionId: "id",
            name: "weekly-incidents",
            scheduleId: "schedule",
            scheduledAt: "2026-09-25T12:00:00Z",
          },
        });
        expect(runtime.createSession).toHaveBeenCalledOnce();
      },
    );
    it("starts a channel-less task with schedule provenance and app auth", async () => {
      const runtime = createMockRuntime();
      runtime.createSession = vi.fn(async (run) => {
        expect(contextStorage.getStore()?.get(ScheduleIdKey)).toBe("queries");
        expect(run).toMatchObject({
          adapter: SCHEDULE_ADAPTER,
          auth: SCHEDULE_APP_AUTH,
          mode: "task",
          input: { message: expect.stringContaining("Request:\nReview open incidents") },
        });
        return createMockRunHandle();
      });
      const result = await new ScheduleDispatcher({ runtime, channels: [] }).triggerCollection({
        collectionId: "queries",
        payload: payload("app"),
        occurrence: {
          scheduledAt: "2026-09-20T12:00:00.000Z",
          executionId: "occurrence_1",
          name: "weekly-incidents",
          scheduleId: "schedule_1",
        },
      });
      expect(result.sessions).toHaveLength(1);
      expect(result.waitUntilTasks).toEqual([]);
    });

    it("rejects invalid persisted requests before starting a session", async () => {
      const runtime = createMockRuntime();
      await expect(
        new ScheduleDispatcher({ runtime, channels: [] }).triggerCollection({
          collectionId: "queries",
          payload: { ...payload("app"), request: " " },
          occurrence: {
            scheduledAt: "now",
            executionId: "id",
            name: "name",
            scheduleId: "schedule",
          },
        }),
      ).rejects.toThrow("Invalid scheduled request payload");
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
          mode: "task",
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
      const dispatcher = new ScheduleDispatcher({ runtime, channels: [] });

      await expect(dispatcher.trigger({ scheduleId: "heartbeat", markdown: "x" })).rejects.toThrow(
        "boom",
      );
    });
  });

  describe("run handler form", () => {
    it("invokes the author's run() with { to, waitUntil, appAuth }", async () => {
      const runtime = createMockRuntime();
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
      vi.stubEnv("SLACK_SIGNING_SECRET", "test-secret");
      try {
        const { definition, resolved } = makeSlackChannelEntry();
        const dispatcher = new ScheduleDispatcher({ runtime, channels: [resolved] });

        const observed: { hasAppAuth: boolean; hasWaitUntil: boolean } = {
          hasAppAuth: false,
          hasWaitUntil: false,
        };

        const result = await dispatcher.trigger({
          scheduleId: "daily-digest",
          async run({ to, waitUntil, appAuth }) {
            observed.hasAppAuth = appAuth.principalId === "eve:app";
            observed.hasWaitUntil = typeof waitUntil === "function";
            await to(definition, { channelId: "C0123ABC" }).send("post the digest", {
              auth: appAuth,
            });
          },
        });

        expect(observed.hasAppAuth).toBe(true);
        expect(observed.hasWaitUntil).toBe(true);
        expect(result.sessions).toHaveLength(1);
        expect(runtime.createSession).toHaveBeenCalledTimes(1);

        const runInput = vi.mocked(runtime.createSession).mock.calls[0]![0];
        expect(runInput.continuationToken).toMatch(
          /^slack:C0123ABC:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
        );
        expect(runInput.auth).toEqual(SCHEDULE_APP_AUTH);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("collects waitUntil promises so the caller can await them", async () => {
      const runtime = createMockRuntime();
      const dispatcher = new ScheduleDispatcher({ runtime, channels: [] });

      const result = await dispatcher.trigger({
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
      const observedScheduleIds: Array<string | undefined> = [];
      runtime.createSession = vi.fn(async () => {
        observedScheduleIds.push(contextStorage.getStore()?.get(ScheduleIdKey));
        return createMockRunHandle();
      });
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
      vi.stubEnv("SLACK_SIGNING_SECRET", "test-secret");
      try {
        const { definition, resolved } = makeSlackChannelEntry();
        const dispatcher = new ScheduleDispatcher({ runtime, channels: [resolved] });

        const result = await dispatcher.trigger({
          scheduleId: "dynamic-tasks",
          run({ to, waitUntil }) {
            waitUntil(
              Promise.resolve().then(() =>
                to(definition, { channelId: "C0123ABC" }).send("run", {
                  auth: {
                    attributes: {},
                    authenticator: "slack",
                    principalId: "schedule-owner",
                    principalType: "user",
                  },
                }),
              ),
            );
          },
        });

        await Promise.all(result.waitUntilTasks);
        expect(observedScheduleIds).toEqual(["dynamic-tasks"]);
        expect(contextStorage.getStore()?.get(ScheduleIdKey)).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("throws when ctx.to(channel) is called with an unregistered channel", async () => {
      const runtime = createMockRuntime();
      const dispatcher = new ScheduleDispatcher({ runtime, channels: [] });
      const stranger = {
        __kind: CHANNEL_SENTINEL,
        routes: [],
        adapter: { kind: "x" },
      } satisfies CompiledChannel;

      await expect(
        dispatcher.trigger({
          scheduleId: "stranger",
          async run({ to }) {
            await to(stranger, {}).send("x", { auth: null });
          },
        }),
      ).rejects.toThrow(/not registered in this agent/);
    });
  });

  it("throws when neither run nor markdown is provided", async () => {
    const runtime = createMockRuntime();
    const dispatcher = new ScheduleDispatcher({ runtime, channels: [] });

    await expect(dispatcher.trigger({ scheduleId: "empty" })).rejects.toThrow(
      /has neither "run" nor "markdown"/,
    );
  });
});
