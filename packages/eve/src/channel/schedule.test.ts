import { describe, expect, it, vi } from "vitest";

import { CHANNEL_SENTINEL, type CompiledChannel } from "#channel/compiled-channel.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  SCHEDULE_ADAPTER,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_APP_AUTH,
  ScheduleDispatcher,
} from "#channel/schedule.js";
import type { RunHandle, Runtime } from "#channel/types.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

function createMockRunHandle(): RunHandle {
  return {
    continuationToken: "slack:C0123ABC:",
    events: new ReadableStream<HandleMessageStreamEvent>(),
    sessionId: "mock-session-id",
  };
}

function createMockRuntime(): Runtime {
  return {
    deliver: vi.fn().mockRejectedValue(new Error("no parked session")),
    run: vi.fn().mockResolvedValue(createMockRunHandle()),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream<HandleMessageStreamEvent>()),
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
  describe("markdown form", () => {
    it("starts a Session via runtime.run with the SCHEDULE_ADAPTER", async () => {
      const runtime = createMockRuntime();
      const dispatcher = new ScheduleDispatcher({ runtime, channels: [] });

      const result = await dispatcher.trigger({
        scheduleId: "heartbeat",
        markdown: "Run heartbeat task.",
      });

      expect(runtime.run).toHaveBeenCalledWith(
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

    it("propagates runtime.run failures", async () => {
      const runtime = createMockRuntime();
      runtime.run = vi.fn().mockRejectedValue(new Error("boom"));
      const dispatcher = new ScheduleDispatcher({ runtime, channels: [] });

      await expect(dispatcher.trigger({ scheduleId: "heartbeat", markdown: "x" })).rejects.toThrow(
        "boom",
      );
    });
  });

  describe("run handler form", () => {
    it("invokes the author's run() with { receive, waitUntil, appAuth }", async () => {
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
          async run({ receive, waitUntil, appAuth }) {
            observed.hasAppAuth = appAuth.principalId === "eve:app";
            observed.hasWaitUntil = typeof waitUntil === "function";
            await receive(definition, {
              message: "post the digest",
              target: { channelId: "C0123ABC" },
              auth: appAuth,
            });
          },
        });

        expect(observed.hasAppAuth).toBe(true);
        expect(observed.hasWaitUntil).toBe(true);
        expect(result.sessions).toHaveLength(1);
        expect(runtime.run).toHaveBeenCalledTimes(1);

        const runInput = vi.mocked(runtime.run).mock.calls[0]![0];
        expect(runInput.continuationToken).toBe("slack:C0123ABC:");
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

    it("throws when args.receive(channel) is called with an unregistered channel", async () => {
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
          async run({ receive }) {
            await receive(stranger, { message: "x", target: {}, auth: null });
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
