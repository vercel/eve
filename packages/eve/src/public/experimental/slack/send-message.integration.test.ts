import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  slackSendMessage,
  type SlackSendMessageOptions,
} from "#public/experimental/slack/send-message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { captureSlackActionContext } from "#public/experimental/slack/action-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, ScheduleOriginKey } from "#context/keys.js";
import { serializeContext, deserializeContext } from "#context/serialize.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { ScheduleDispatcher } from "#channel/schedule.js";
import { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";
import { buildSlackAuthContext } from "#public/channels/slack/auth.js";
import { defineScheduleCollection, type ScheduleDelivery } from "#public/schedules/collection.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { bindScheduleCollection } from "#runtime/schedules/collection-client.js";
import { parseSchedulePayload } from "#runtime/schedules/payload.js";
import type { Runtime } from "#channel/types.js";
import type { ToolContext } from "#tools/definition.js";

const creator = buildSlackAuthContext({
  teamId: "T123",
  channelId: "C123",
  threadTs: "1700000000.000001",
  userId: "U123",
});
const laterUser = buildSlackAuthContext({
  teamId: "T123",
  channelId: "C456",
  threadTs: "1700000002.000001",
  userId: "U456",
});
const receiptTs = "1700000001.000002";
let requests: Array<{ operation: string; body: Record<string, string> }>;
let response: Record<string, unknown> | undefined;
const botToken = vi.fn(async () => "private-test-token");
const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const operation = String(url).split("/").at(-1)!;
  const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
  requests.push({ operation, body });
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-test-token");
  return Response.json(
    response ??
      (operation === "conversations.open"
        ? { ok: true, channel: { id: "D123" } }
        : { ok: true, channel: body.channel, ts: receiptTs }),
  );
});
const context = (auth = creator): ToolContext => ({
  session: {
    id: "current-session",
    auth: { current: auth, initiator: laterUser },
    turn: { id: "turn", sequence: 0 },
  },
  abortSignal: new AbortController().signal,
  callId: "call",
  toolName: "send-slack",
  getSandbox: vi.fn(),
  getToken: vi.fn(),
  requireAuth: vi.fn() as never,
});
function liveScope(installationTeamId = "T999") {
  const scope = new ContextContainer();
  scope.set(ChannelKey, {
    kind: "channel:slack",
    state: {
      installationTeamId,
      teamId: "T123",
      triggeringUserId: "U123",
      channelId: "C123",
      threadTs: "1700000000.000001",
    },
  });
  return scope;
}
function tool(options: Partial<SlackSendMessageOptions> = {}) {
  const action = slackSendMessage({ botToken, ...options });
  return {
    execute: (...args: Parameters<typeof action.execute>) =>
      contextStorage.run(contextStorage.getStore() ?? liveScope(), () => action.execute(...args)),
  };
}
const capturedSlack = () =>
  contextStorage.run(liveScope(), () => captureSlackActionContext(creator));

beforeEach(() => {
  requests = [];
  response = undefined;
  vi.clearAllMocks();
  vi.stubGlobal("fetch", transport);
});
afterEach(() => vi.unstubAllGlobals());

describe("reusable Slack message action", () => {
  it("opens the current requester's DM and posts directly with a confirmed receipt", async () => {
    const result = await tool().execute(
      { target: "requester", message: "Review the report" },
      context(),
    );
    expect(requests).toEqual([
      { operation: "conversations.open", body: { users: "U123" } },
      {
        operation: "chat.postMessage",
        body: {
          channel: "D123",
          text: "Review the report",
          unfurl_links: "false",
          unfurl_media: "false",
        },
      },
    ]);
    expect(result).toEqual({ delivered: true, channelId: "D123", messageId: receiptTs });
    expect(botToken).toHaveBeenCalledWith({ teamId: "T999" });
    expect(JSON.stringify(result)).not.toContain("private-test-token");
  });

  it("posts an origin reply in the captured thread without a new agent turn", async () => {
    await tool().execute({ target: "origin", message: "The report is ready" }, context());
    expect(requests).toEqual([
      {
        operation: "chat.postMessage",
        body: {
          channel: "C123",
          thread_ts: "1700000000.000001",
          text: "The report is ready",
          unfurl_links: "false",
          unfurl_media: "false",
        },
      },
    ]);
  });

  it.each(["creator", "app"] as const)(
    "uses the same tool for a persisted %s occurrence without resuming its origin session",
    async (runAs) => {
      let delivery: ScheduleDelivery | undefined;
      const definition = defineScheduleCollection({
        provider: inMemoryScheduleProvider(),
        scope: "fixture",
        runAs,
      });
      const source = liveScope();
      const client = await contextStorage.run(source, () =>
        bindScheduleCollection(
          "tasks",
          definition,
          {
            application: "fixture",
            abortSignal: new AbortController().signal,
            channel: { kind: "channel:slack" },
            session: { id: "retired-origin", auth: { current: creator, initiator: laterUser } },
          },
          async (value) => {
            delivery = value;
          },
        ),
      );
      source.get(ChannelKey)!.state!.installationTeamId = "T456";
      await client!.create({
        name: "report",
        expression: { type: "cron", cron: "0 9 * * *" },
        payload: "DM me the report",
      });
      await client!.invoke("report");
      const runtime: Runtime = {
        createSession: vi.fn(async (run) => {
          const seeded = buildRunContext({
            bundle: {
              compiledArtifactsSource: {
                kind: "disk",
                appRoot: "/fixture",
                durableReference: "development",
              },
            } as never,
            run,
          });
          const serialized = serializeContext(seeded);
          // This test exercises plain durable keys without loading a compiled bundle or adapter.
          const restored = await deserializeContext(
            JSON.parse(
              JSON.stringify({
                [ScheduleOriginKey.name]: serialized[ScheduleOriginKey.name],
                [AuthKey.name]: serialized[AuthKey.name],
                [InitiatorAuthKey.name]: serialized[InitiatorAuthKey.name],
              }),
            ),
          );
          const result = await contextStorage.run(restored, () =>
            tool().execute({ target: "requester", message: "Your report" }, context(run.auth)),
          );
          expect(result).toMatchObject({ delivered: true });
          expect(run.auth).toEqual(runAs === "creator" ? creator : SCHEDULE_APP_AUTH);
          return { sessionId: "scheduled-session", events: new ReadableStream() };
        }),
        dispatchSession: vi.fn(),
        dispatchContinuation: vi.fn(),
        resolveContinuation: vi.fn(),
        getEventStream: vi.fn(),
        getStreamTailIndex: vi.fn(),
      };
      await new ScheduleDispatcher({ runtime, channels: [] }).triggerCollection({
        collectionId: "tasks",
        payload: parseSchedulePayload(delivery!.payload),
        occurrence: delivery!.occurrence,
      });
      expect(requests[0]).toEqual({ operation: "conversations.open", body: { users: "U123" } });
      expect(runtime.dispatchSession).not.toHaveBeenCalled();
      expect(botToken).toHaveBeenCalledWith({ teamId: "T999" });
      expect(botToken).not.toHaveBeenCalledWith({ teamId: "T123" });
      expect(botToken).not.toHaveBeenCalledWith({ teamId: "T456" });
    },
  );

  it("uses the captured thread and ignores model-supplied thread overrides for origin", async () => {
    const scope = new ContextContainer();
    scope.set(ScheduleOriginKey, {
      sessionId: "retired-origin",
      auth: { current: creator, initiator: laterUser },
      channel: {},
      slack: capturedSlack(),
    });
    await contextStorage.run(scope, () =>
      tool().execute(
        { target: "origin", message: "Report", threadTs: "1700000009.000001" } as never,
        context(laterUser),
      ),
    );
    expect(requests[0]?.body).toMatchObject({ channel: "C123", thread_ts: "1700000000.000001" });
  });

  it.each([{ ok: false }, { ok: true, channel: { id: "C123" } }, { ok: true }])(
    "does not post when DM resolution fails",
    async (value) => {
      response = value;
      await expect(
        tool().execute({ target: "requester", message: "Report" }, context()),
      ).rejects.toThrow("could not open");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.operation).toBe("conversations.open");
    },
  );

  it("never falls back to a later caller when a stored origin has no requester", async () => {
    const scope = new ContextContainer();
    scope.set(ScheduleOriginKey, {
      sessionId: "old",
      auth: { current: null, initiator: creator },
      channel: {},
    });
    await expect(
      contextStorage.run(scope, () =>
        tool().execute({ target: "requester", message: "Report" }, context(laterUser)),
      ),
    ).rejects.toThrow("verified requester");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { target: "user:U456", message: "report" },
    { target: "channel:C456", message: "report" },
    { target: "requester-extra", message: "report" },
    { target: "requester", message: "x".repeat(4001) },
  ])("rejects unsupported or unauthorized delivery before credential resolution", async (input) => {
    await expect(tool().execute(input, context())).rejects.toThrow();
    expect(botToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("supports explicitly app-authorized channel targets without schedule-specific configuration", async () => {
    const action = tool({ channelIds: { T999: ["C456"] } });
    await action.execute({ target: "channel:C456", message: "Report" }, context());
    expect(requests[0]?.body.channel).toBe("C456");
  });

  it("rejects caller identity inconsistent with the live channel context", async () => {
    const otherTeam = buildSlackAuthContext({
      teamId: "T456",
      channelId: "C456",
      userId: "U123",
      threadTs: "1700000000.000001",
    });
    await expect(
      tool().execute({ target: "requester", message: "report" }, context(otherTeam)),
    ).rejects.toThrow("missing or inconsistent");
    await expect(
      tool().execute(
        { target: "requester", message: "report" },
        context({ ...creator, attributes: { ...creator.attributes, user_id: "U456" } }),
      ),
    ).rejects.toThrow("inconsistent");
    expect(botToken).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, error: "private-server-detail" },
    { ok: true },
    { ok: true, channel: "C456", ts: receiptTs },
  ])(
    "does not report delivery without a matching receipt or fall back to another destination",
    async (value) => {
      response = value;
      await expect(
        tool().execute({ target: "origin", message: "Report" }, context()),
      ).rejects.toThrow(/^Slack/);
      expect(requests).toHaveLength(1);
    },
  );

  it("does not retry ambiguous sends or disclose provider errors", async () => {
    transport.mockRejectedValueOnce(new Error("private-test-token"));
    await expect(
      tool().execute({ target: "origin", message: "Report" }, context()),
    ).rejects.toThrow("could not be confirmed");
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, "", "invalid"])(
    "does not use caller workspace when installation is missing (%s)",
    async (installationTeamId) => {
      const scope = liveScope();
      scope.get(ChannelKey)!.state!.installationTeamId = installationTeamId;
      await expect(
        contextStorage.run(scope, () =>
          tool().execute({ target: "requester", message: "Report" }, context()),
        ),
      ).rejects.toThrow("installation context");
      expect(botToken).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to a live installation for an old schedule without captured context", async () => {
    const scope = liveScope();
    scope.set(ScheduleOriginKey, {
      sessionId: "old",
      auth: { current: creator, initiator: null },
      channel: {},
    });
    await expect(
      contextStorage.run(scope, () =>
        tool().execute({ target: "origin", message: "Report" }, context()),
      ),
    ).rejects.toThrow("recreate the schedule");
    expect(botToken).not.toHaveBeenCalled();
  });

  it("keeps additional channel grants scoped to the receiving installation", async () => {
    await expect(
      tool({ channelIds: { T123: ["C456"] } }).execute(
        { target: "channel:C456", message: "Report" },
        context(),
      ),
    ).rejects.toThrow("not authorized");
    expect(botToken).not.toHaveBeenCalled();
  });

  it("does not send when already cancelled", async () => {
    await expect(
      tool().execute(
        { target: "origin", message: "Report" },
        { ...context(), abortSignal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
