import type { SessionStreamEvent } from "#protocol/session-event.js";
import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_SENTINEL,
  type CompiledChannel,
  isCompiledChannel,
} from "#channel/compiled-channel.js";
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
import {
  defineDynamicSchedules,
  type DynamicSchedulesRunArgs,
  type DynamicSchedulesToFn,
  type ScheduleHandle,
  type SchedulePrincipalReference,
} from "#public/schedules/subscription.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { PermanentScheduleMessageError } from "#internal/schedules/verify-delivery.js";
import type { MessageContent } from "#shared/message-content.js";
import { createScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import { z } from "#compiled/zod/index.js";
import { defineChannel } from "#public/definitions/channel.js";

function createMockRunHandle(): RunHandle {
  return { events: new ReadableStream<SessionStreamEvent>(), sessionId: "mock-session-id" };
}
function createMockRuntime(): Runtime {
  return {
    createSession: vi.fn().mockResolvedValue(createMockRunHandle()),
    dispatchContinuation: vi.fn().mockResolvedValue({ status: "session_not_active" }),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream<SessionStreamEvent>()),
    getLineStream: vi.fn().mockResolvedValue(new ReadableStream()),
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
    const occurrence = {
      collection: "requests",
      executionId: "exec-1",
      name: "weekly",
      scheduleId: "sch-1",
      scheduledAt: "2026-09-29T19:00:00Z",
    };
    type AuthResult = SessionAuthContext | Pick<SessionAuthContext, "attributes"> | null;
    function setup(
      auth:
        | AuthResult
        | ((context: { schedule: ScheduleHandle }) => AuthResult | Promise<AuthResult>) = creator,
      idempotencyKey?: string,
      principal: SchedulePrincipalReference = {
        type: "user",
        authenticator: "test",
        principalId: "alice",
      },
      sends = 1,
      // Replaces the default send with the sends a test scripts.
      script?: (
        send: (channelId: string, message: MessageContent) => Promise<unknown>,
      ) => Promise<void>,
    ) {
      const runtime = createMockRuntime();
      const targets: string[] = [];
      const channel = defineChannel<undefined, void, { channelId: string }>({
        routes: [],
        async receive(input, context) {
          targets.push(input.target.channelId);
          return await context
            .from(input.target.channelId)
            .send(input.message, { auth: input.auth, idempotencyKey: input.idempotencyKey });
        },
      });
      const run = vi.fn(
        async (args: {
          payload: { task: string; destination: string };
          to: DynamicSchedulesToFn;
          auth: SessionAuthContext;
          waitUntil: (task: Promise<unknown>) => void;
        }) => {
          if (script !== undefined) {
            await script((channelId, message) => args.to(channel, { channelId }).send(message));
            return;
          }
          const channelId =
            args.payload.destination === "my-dm" ? `dm-${args.auth.principalId}` : "team-channel";
          for (let sent = 0; sent < sends; sent += 1)
            args.waitUntil(
              args.to(channel, { channelId }).send(args.payload.task, { idempotencyKey }),
            );
        },
      );
      const definition = defineDynamicSchedules({
        provider: inMemoryScheduleProvider(),
        inputSchema: z.object({ task: z.string(), destination: z.enum(["my-dm", "team-channel"]) }),
        auth: typeof auth === "function" ? auth : () => auth,
        run,
      });
      const payload = createScheduleCollectionPayload({
        application: "fixture",
        collection: "requests",
        envelope: {
          version: 3,
          payload: { task: "Summarize the week.", destination: "my-dm" },
          scope: "alice",
          principal,
        },
      });
      const dispatcher = new ScheduleDispatcher({
        runtime,
        channels: [
          {
            name: "outbox",
            method: "POST",
            urlPath: "/outbox",
            logicalPath: "channels/outbox.ts",
            sourceId: "outbox",
            sourceKind: "module",
            definition: channel as CompiledChannel,
            adapter: (channel as CompiledChannel).adapter,
            receive: channel.receive as CompiledChannel["receive"],
            fetch: async () => new Response(),
          },
        ],
      });
      const input = {
        collectionId: "requests",
        definition,
        namespace: "eve-requests",
        occurrence,
        payload,
        schedule: { disable: async () => {}, delete: async () => {} },
      };
      return { dispatcher, input, runtime, run, targets };
    }

    it("derives a destination from payload intent and starts fresh unattended work as the creator", async () => {
      const { dispatcher, input, runtime, run, targets } = setup();
      const first = await dispatcher.triggerCollection(input);
      const second = await dispatcher.triggerCollection(input);
      expect(targets).toEqual(["dm-alice", "dm-alice"]);
      expect(run).toHaveBeenCalledTimes(2);
      expect(first.sessions).toHaveLength(1);
      expect(second.sessions).toHaveLength(1);
      const started = vi.mocked(runtime.createSession).mock.calls.map(([value]) => value);
      expect(started[0]).toMatchObject({
        auth: { principalId: "alice", attributes: {} },
        capabilities: { requestInput: false },
        input: { message: "Summarize the week." },
      });
      // A send without a key takes one from the occurrence, so the retry reaches the first session.
      expect(started[1]!.continuationToken).toBe(started[0]!.continuationToken);
      expect(started[1]).toMatchObject({
        idempotencyKey: expect.stringMatching(/^eve-occurrence:[0-9a-f]{64}$/u),
        continuationConflictCommand: { idempotencyKey: started[0]!.idempotencyKey, kind: "send" },
      });
      expect(runtime.dispatchContinuation).not.toHaveBeenCalled();
    });

    it("keys unkeyed sends apart for another occurrence and for a repeated message", async () => {
      const { dispatcher, input, runtime } = setup(creator, undefined, undefined, 2);
      await dispatcher.triggerCollection(input);
      await dispatcher.triggerCollection({
        ...input,
        occurrence: { ...input.occurrence, executionId: "exec-2" },
      });
      const tokens = vi
        .mocked(runtime.createSession)
        .mock.calls.map(([value]) => value.continuationToken);
      expect(new Set(tokens).size).toBe(4);
    });

    it("starts a keyed send without looking up an earlier session", async () => {
      const { dispatcher, input, runtime } = setup(creator, "exec-1:digest");
      await dispatcher.triggerCollection(input);
      await dispatcher.triggerCollection(input);
      expect(runtime.dispatchContinuation).not.toHaveBeenCalled();
      const started = vi.mocked(runtime.createSession).mock.calls.map(([value]) => value);
      expect(started).toHaveLength(2);
      // A retried callback claims the same address, so its start reaches the first session.
      expect(started[1]!.continuationToken).toBe(started[0]!.continuationToken);
      expect(started[1]).toMatchObject({
        idempotencyKey: "exec-1:digest",
        continuationConflictCommand: { idempotencyKey: "exec-1:digest", kind: "send" },
      });
    });

    it("keeps a fan-out's keys when a retry reaches its targets in another order", async () => {
      let order = ["A", "B"];
      const { dispatcher, input, runtime } = setup(
        creator,
        undefined,
        undefined,
        1,
        async (send) => {
          for (const channelId of order) await send(channelId, "The digest.");
        },
      );
      await dispatcher.triggerCollection(input);
      order = ["B", "A"];
      await dispatcher.triggerCollection(input);
      const tokens = vi
        .mocked(runtime.createSession)
        .mock.calls.map(([value]) => value.continuationToken);
      expect(tokens).toHaveLength(4);
      // The retry's sends reach the two sessions the first attempt started.
      expect(tokens[2]).toBe(tokens[1]);
      expect(tokens[3]).toBe(tokens[0]);
      expect(new Set(tokens).size).toBe(2);
    });

    it("keys an unkeyed send by its file's bytes", async () => {
      const file = (
        bytes: number[],
        data: (value: Uint8Array) => Uint8Array | ArrayBuffer = (value) => value,
      ): MessageContent => [
        { type: "text", text: "The report." },
        {
          type: "file",
          mediaType: "application/pdf",
          filename: "report.pdf",
          data: data(Uint8Array.from(bytes)),
        },
      ];
      const messages: MessageContent[] = [
        file([1, 2, 3]),
        file([1, 2, 4]),
        // The same bytes key the same, whichever way the file holds them.
        file([1, 2, 3], (value) => value.buffer.slice(0) as ArrayBuffer),
      ];
      const { dispatcher, input, runtime } = setup(
        creator,
        undefined,
        undefined,
        1,
        async (send) => {
          await send("A", messages.shift()!);
        },
      );
      for (let attempt = 0; attempt < 3; attempt += 1) await dispatcher.triggerCollection(input);
      const tokens = vi
        .mocked(runtime.createSession)
        .mock.calls.map(([value]) => value.continuationToken);
      expect(tokens[1]).not.toBe(tokens[0]);
      expect(tokens[2]).toBe(tokens[0]);
    });

    it("distinguishes encoded file data from raw bytes with the same text", async () => {
      const encoded = "AQID";
      const data = [encoded, new TextEncoder().encode(encoded)];
      const { dispatcher, input, runtime } = setup(
        creator,
        undefined,
        undefined,
        1,
        async (send) => {
          await send("A", [{ type: "file", mediaType: "application/pdf", data: data.shift()! }]);
        },
      );
      await dispatcher.triggerCollection(input);
      await dispatcher.triggerCollection(input);
      const tokens = vi
        .mocked(runtime.createSession)
        .mock.calls.map(([value]) => value.continuationToken);
      expect(tokens[1]).not.toBe(tokens[0]);
    });

    it.each([
      ["no issuer or subject", { type: "user", authenticator: "test", principalId: "alice" }],
      [
        "an issuer and subject",
        {
          type: "user",
          authenticator: "test",
          issuer: "https://issuer.test",
          principalId: "alice",
          subject: "sub-alice",
        },
      ],
    ])(
      "builds creator auth from attributes and a stored creator with %s",
      async (_label, stored) => {
        const { dispatcher, input, runtime, run } = setup(
          { attributes: { team: "billing" } },
          undefined,
          stored,
        );
        await dispatcher.triggerCollection(input);
        const { type, ...identity } = stored;
        const auth = { ...identity, principalType: type, attributes: { team: "billing" } };
        expect(run.mock.calls[0]![0].auth).toEqual(auth);
        expect(vi.mocked(runtime.createSession).mock.calls[0]![0]).toMatchObject({
          auth,
          initiatorAuth: auth,
        });
      },
    );

    it("runs as the stored creator even when attributes carry other identity fields", async () => {
      const { dispatcher, input, run } = setup({
        attributes: {},
        authenticator: "other",
        principalType: "service",
      } as Pick<SessionAuthContext, "attributes">);
      await dispatcher.triggerCollection(input);
      expect(run.mock.calls[0]![0].auth).toEqual(creator);
    });

    it.each([
      ["auth returns null", null, /no longer authorized/],
      ["auth returns another principal", { ...creator, principalId: "bob" }, /schedule creator/],
      ["auth returns no attributes", {} as AuthResult, /must return \{ attributes \}/],
      ["auth returns nothing", () => undefined as never, /must return \{ attributes \}/],
    ])(
      "fails permanently without invoking authored code when %s",
      async (_label, auth, message) => {
        const { dispatcher, input, runtime, run } = setup(auth);
        const error = await dispatcher.triggerCollection(input).catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(PermanentScheduleMessageError);
        expect((error as Error).message).toMatch(message);
        expect(run).not.toHaveBeenCalled();
        expect(runtime.createSession).not.toHaveBeenCalled();
      },
    );

    it("lets auth stop the schedule it denies", async () => {
      const { dispatcher, input, run } = setup(async ({ schedule }) => {
        await schedule.disable();
        return null;
      });
      const disable = vi.fn(async () => {});
      input.schedule = { ...input.schedule, disable };
      const error = await dispatcher.triggerCollection(input).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(PermanentScheduleMessageError);
      expect(disable).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
    });

    it("validates provider-delivered payloads before auth or callback side effects", async () => {
      const { dispatcher, input, run } = setup();
      input.payload.envelope.payload.destination = "unknown";
      await expect(dispatcher.triggerCollection(input)).rejects.toThrow("Invalid schedule payload");
      expect(run).not.toHaveBeenCalled();
    });

    it("propagates registered background work failure", async () => {
      const { dispatcher, input } = setup();
      const definition = {
        ...input.definition,
        run: ({ waitUntil }: DynamicSchedulesRunArgs<unknown>) =>
          waitUntil(Promise.reject(new Error("send failed"))),
      };
      await expect(dispatcher.triggerCollection({ ...input, definition })).rejects.toThrow(
        "send failed",
      );
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
      expect(result.sessions[0]!.sessionId).toBe("mock-session-id");
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
    // https://github.com/vercel/eve/issues/5598
    it("tags to() sends with the Vercel deployment running the schedule", async () => {
      vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_current");
      try {
        const runtime = createMockRuntime();
        runtime.dispatchContinuation = vi
          .fn()
          .mockResolvedValue({ sessionId: "existing-session", status: "accepted" });
        const thread: CompiledChannel = {
          __kind: CHANNEL_SENTINEL,
          routes: [],
          adapter: { kind: "channel:thread" },
          receive: async ({ auth, message, target }, { from }) =>
            await from(String(target.address)).send(message, { auth }),
        };
        const resolved: ResolvedChannelDefinition = {
          name: "thread",
          method: "POST",
          urlPath: "/thread",
          logicalPath: "channels/thread.ts",
          sourceId: "channel-thread",
          sourceKind: "module",
          adapter: thread.adapter,
          definition: thread,
          receive: thread.receive,
          fetch: async () => new Response("ok"),
        };
        await new ScheduleDispatcher({ runtime, channels: [resolved] }).trigger({
          scheduleId: "daily",
          async run({ to }) {
            await to(thread, { address: "C1:1761400000.000100" }).send("daily check", {
              auth: null,
            });
          },
        });
        expect(runtime.dispatchContinuation).toHaveBeenCalledWith(
          expect.objectContaining({
            command: expect.objectContaining({
              delivery: expect.objectContaining({ acceptedDeploymentId: "dpl_current" }),
            }),
          }),
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });
    // the turn a scheduled send starts in a conversation must know a schedule sent it.
    it("marks to() sends into an existing conversation with the schedule", async () => {
      const runtime = createMockRuntime();
      runtime.dispatchContinuation = vi
        .fn()
        .mockResolvedValue({ sessionId: "existing-session", status: "accepted" });
      const thread: CompiledChannel = {
        __kind: CHANNEL_SENTINEL,
        routes: [],
        adapter: { kind: "channel:thread" },
        receive: async ({ auth, message, target }, { from }) =>
          await from(String(target.address)).send(message, { auth }),
      };
      const resolved: ResolvedChannelDefinition = {
        name: "thread",
        method: "POST",
        urlPath: "/thread",
        logicalPath: "channels/thread.ts",
        sourceId: "channel-thread",
        sourceKind: "module",
        adapter: thread.adapter,
        definition: thread,
        receive: thread.receive,
        fetch: async () => new Response("ok"),
      };
      await new ScheduleDispatcher({ runtime, channels: [resolved] }).trigger({
        scheduleId: "daily",
        async run({ to }) {
          await to(thread, { address: "C1:1761400000.000100" }).send("daily check", {
            auth: null,
          });
        },
      });
      expect(runtime.dispatchContinuation).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({ schedule: { definition: "daily" } }),
        }),
      );
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
