import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelOperations } from "#channel/channel-operations.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { ToolContext } from "#tools/definition.js";
import type {
  AuthorizationDefinition,
  ConnectionPrincipal,
  TokenResult,
} from "#shared/connection-types.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { toInputSchema } from "#tools/schema.js";
import {
  buildSerializedContext,
  captureEvents,
  expectHookClaims,
  expectSingleTurn,
} from "#internal/testing/entry-test-helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workflowEntry integration", () => {
  it("sends a first-turn sign-in privately to a custom-auth Slack author", async () => {
    const signingSecret = "first-turn-signing-secret";
    const ephemeral: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "slack.com") return realFetch(input, init);
      if (url.pathname.endsWith("/chat.postEphemeral")) {
        ephemeral.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
      }
      return Response.json({ ok: true, ts: "1700000000.000900", messages: [] });
    });
    const slack = slackChannel({
      credentials: { botToken: "xoxb-test", signingSecret },
      onDirectMessage: () => ({
        auth: {
          attributes: {},
          authenticator: "employee-directory",
          principalId: "employee:alice",
          principalType: "user",
        },
      }),
    });
    if (!isCompiledChannel(slack)) throw new Error("Expected a compiled Slack channel.");
    const route = slack.routes.find((candidate) => candidate.method === "POST");
    if (route === undefined || !isHttpRouteDefinition(route)) {
      throw new Error("Expected the Slack events route.");
    }
    const { runtime } = await createWeatherAuthRuntime("workflow-entry-slack-first-turn-auth", [
      { logicalPath: "channels/slack.ts", loadNamespace: async () => ({ default: slack }) },
    ]);

    await runtime.run(async () => {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const resolved = bundle.graph.root.channels.find((channel) => channel.name === "slack");
      if (resolved?.adapter === undefined) throw new Error("Expected the resolved Slack channel.");
      const operations = createChannelOperations<unknown>({
        adapter: resolved.adapter,
        channelName: "slack",
        runtime: createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        }),
      });
      const body = JSON.stringify({
        event: {
          channel: "D_ALICE",
          channel_type: "im",
          event_ts: "1700000000.000100",
          text: "Use the get_weather tool to check the weather in Lisbon.",
          ts: "1700000000.000100",
          type: "message",
          user: "U_ALICE",
        },
        event_id: "Ev_first_turn_auth",
        team_id: "T01",
        type: "event_callback",
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = `v0=${createHmac("sha256", signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`;
      const pending: Promise<unknown>[] = [];
      await route.handler(
        new Request("https://agent.example.com/eve/v1/slack", {
          body,
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": String(timestamp),
            "x-slack-signature": signature,
          },
          method: "POST",
        }),
        {
          ...operations,
          attachSession: vi.fn() as never,
          params: {},
          requestIp: null,
          to: vi.fn() as never,
          waitUntil: (task) => void pending.push(task),
        },
      );
      await Promise.all(pending);

      await vi.waitFor(() => expect(ephemeral).toHaveLength(1), { timeout: 20_000 });
      expect(ephemeral[0]).toMatchObject({ channel: "D_ALICE", user: "U_ALICE" });
    });
  });

  it("resumes normal follow-ups after an interactive authorization callback", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-auth-followup",
    );
    const continuationToken = "http:workflow-entry-auth-followup";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Use the get_weather tool to check the weather in Lisbon." },
          serializedContext: buildSerializedContext({
            auth: {
              attributes: {},
              authenticator: "test-idp",
              issuer: "test-idp",
              principalId: "user-1",
              principalType: "user",
            },
            channelKind: "http",
            continuationToken,
          }),
        },
      ]);

      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial auth-required event",
          (event) => event.type === "authorization.required",
        );
        const required = filterEventsByType(firstTurn, "authorization.required");

        expect(firstTurn.at(-1)?.type).toBe("authorization.required");
        expect(required).toHaveLength(1);
        expect(required[0]?.data).toMatchObject({
          name: "weather",
          authorization: { displayName: "Weather" },
        });

        // The sign-in holds the turn open, as a question or task does.
        const held = await stream.nextUntil(
          "authorization hold",
          (event) => event.type === "turn.waiting",
        );
        expect(held.map((event) => event.type)).toEqual(["turn.waiting"]);
        expect(filterEventsByType(held, "turn.waiting")[0]?.data).toMatchObject({
          turnId: "turn_0",
        });
        await expectHookClaims(run.runId, [sessionCommandHookToken(run.runId), continuationToken]);

        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId: authorizationAttemptId(firstTurn),
                callback: {
                  method: "GET",
                  params: { code: "oauth-code" },
                },
                connectionName: "weather",
              },
            },
          ],
        });

        const authorizedTurn = await stream.nextUntil(
          "authorization callback turn",
          (event) => event.type === "session.waiting",
        );
        const completed = filterEventsByType(authorizedTurn, "authorization.completed");

        expect(completeCalls()).toBe(1);
        // The held turn resumes: no new turn starts, and the same turn completes.
        expect(filterEventsByType(authorizedTurn, "turn.started")).toHaveLength(0);
        expect(filterEventsByType(authorizedTurn, "turn.completed")[0]?.data).toMatchObject({
          turnId: "turn_0",
        });
        expect(authorizedTurn.at(-1)?.type).toBe("session.waiting");
        expect(completed).toHaveLength(1);
        expect(completed[0]?.data).toMatchObject({
          name: "weather",
          outcome: "authorized",
        });
        expect(
          authorizedTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("Used local weather tool for Lisbon") === true,
          ),
        ).toBe(true);

        await waitForHook(
          { runId: run.runId },
          {
            token: sessionInboxHookToken(continuationToken),
          },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          kind: "send",
          payload: { message: "follow up after auth" },
        });

        const followupTurn = await stream.nextUntil(
          "post-auth follow-up turn",
          (event) => event.type === "session.waiting",
        );

        expect(followupTurn.at(-1)?.type).toBe("session.waiting");
        expect(
          followupTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after auth") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("queues another person's message behind a held sign-in", async () => {
    const { completeCalls, completedPrincipals, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-auth-queued",
    );
    const continuationToken = "http:workflow-entry-auth-queued";

    await runtime.run(async () => {
      const run = await startWeatherRun(continuationToken);
      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial auth-required event",
          (event) => event.type === "authorization.required",
        );
        await stream.nextUntil("authorization hold", (event) => event.type === "turn.waiting");

        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          auth: userAuth("user-2"),
          kind: "send",
          payload: { message: "Quick status note while I sign in." },
        });
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [weatherCallback(authorizationAttemptId(firstTurn))],
        });

        // The held turn resumes first, as user-1, and finishes the tool call.
        const resumed = await stream.nextUntil(
          "resumed held turn",
          (event) => event.type === "session.waiting",
        );
        expect(filterEventsByType(resumed, "turn.started")).toHaveLength(0);
        expect(filterEventsByType(resumed, "authorization.completed")[0]?.data).toMatchObject({
          name: "weather",
          outcome: "authorized",
          principalId: "user-1",
        });
        expect(filterEventsByType(resumed, "turn.completed")[0]?.data).toMatchObject({
          turnId: "turn_0",
        });
        expect(
          resumed.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("authorized with weather-token") === true,
          ),
        ).toBe(true);
        expect(completeCalls()).toBe(1);
        expect(completedPrincipals()).toEqual([
          expect.objectContaining({ id: "user-1", type: "user" }),
        ]);

        // user-2's message waited behind the held turn and runs next.
        const queued = await stream.nextUntil(
          "queued message turn",
          (event) => event.type === "session.waiting",
        );
        expectSingleTurn(queued, "turn_1");
        expect(
          queued.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("Quick status note while I sign in.") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("cancels a held sign-in when the same person steers the turn, ignoring its late callback", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-auth-steered",
    );
    const continuationToken = "http:workflow-entry-auth-steered";

    await runtime.run(async () => {
      const run = await startWeatherRun(continuationToken);
      const stream = captureEvents(run);

      try {
        const firstAttempt = await stream.nextUntil(
          "first auth-required event",
          (event) => event.type === "authorization.required",
        );
        await stream.nextUntil("first hold", (event) => event.type === "turn.waiting");

        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          auth: userAuth("user-1"),
          kind: "send",
          payload: { message: "Use the get_weather tool to check the weather in Lisbon." },
        });
        // The steer cancels the open sign-in, and the model's retry asks again
        // in the same turn.
        const replacementAttempt = await stream.nextUntil(
          "replacement auth-required event",
          (event) => event.type === "authorization.required",
        );
        expect(filterEventsByType(replacementAttempt, "turn.started")).toHaveLength(0);
        expect(filterEventsByType(replacementAttempt, "authorization.completed")).toMatchObject([
          { data: { name: "weather", outcome: "declined" } },
        ]);
        await stream.nextUntil("replacement hold", (event) => event.type === "turn.waiting");

        const stale = weatherCallback(authorizationAttemptId(firstAttempt), "stale-oauth-code");
        for (let i = 0; i < 2; i++) {
          await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
            kind: "authorization-callback",
            payloads: [stale],
          });
        }
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [weatherCallback(authorizationAttemptId(replacementAttempt))],
        });

        const resumed = await stream.nextUntil(
          "resumed held turn",
          (event) => event.type === "session.waiting",
        );
        expect(filterEventsByType(resumed, "authorization.completed")).toMatchObject([
          { data: { outcome: "authorized" } },
        ]);
        expect(filterEventsByType(resumed, "turn.completed")[0]?.data).toMatchObject({
          turnId: "turn_0",
        });
        expect(completeCalls()).toBe(1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("cancelling a held turn drops its sign-in, so a late callback does nothing", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime("workflow-entry-auth-cancel");
    const continuationToken = "http:workflow-entry-auth-cancel";

    await runtime.run(async () => {
      const run = await startWeatherRun(continuationToken);
      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial auth-required event",
          (event) => event.type === "authorization.required",
        );
        await stream.nextUntil("authorization hold", (event) => event.type === "turn.waiting");

        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), { kind: "cancel" });
        const cancelled = await stream.nextUntil(
          "cancelled held turn",
          (event) => event.type === "session.waiting",
        );
        expect(filterEventsByType(cancelled, "authorization.completed")).toMatchObject([
          { data: { name: "weather", outcome: "declined" } },
        ]);
        expect(filterEventsByType(cancelled, "turn.cancelled")).toHaveLength(1);

        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [weatherCallback(authorizationAttemptId(firstTurn))],
        });
        await resumeHook(sessionInboxHookToken(continuationToken), {
          auth: userAuth("user-1"),
          kind: "send",
          payload: { message: "follow up after cancel" },
        });
        const followup = await stream.nextUntil(
          "follow-up turn",
          (event) => event.type === "session.waiting",
        );
        expect(filterEventsByType(followup, "authorization.completed")).toHaveLength(0);
        expect(completeCalls()).toBe(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});

interface WeatherAuthRuntime {
  completeCalls(): number;
  completedPrincipals(): readonly ConnectionPrincipal[];
  runtime: Awaited<ReturnType<typeof createTestRuntime>>;
}

/**
 * A get_weather tool behind an interactive authorization: getToken always
 * requires sign-in, and completeAuthorization mints `weather-token` from the
 * `oauth-code` callback. Shared by the callback-resume and
 * challenge-stays-open owner tests.
 */
async function createWeatherAuthRuntime(
  agentName: string,
  modules: NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"] = [],
): Promise<WeatherAuthRuntime> {
  let completeCalls = 0;
  const completedPrincipals: ConnectionPrincipal[] = [];
  const weatherAuth: AuthorizationDefinition<{ nonce: string }> = {
    principalType: "user",
    async getToken(): Promise<TokenResult> {
      throw new ConnectionAuthorizationRequiredError("weather");
    },
    async startAuthorization({ callbackUrl }) {
      return {
        challenge: {
          displayName: "Weather",
          instructions: "Sign in to continue.",
          url: `https://idp.example/authorize?callback=${encodeURIComponent(callbackUrl)}`,
        },
        resume: { nonce: "weather-nonce" },
      };
    },
    async completeAuthorization({ callback, principal, resume }): Promise<TokenResult> {
      completeCalls += 1;
      completedPrincipals.push(principal);
      expect(callback.params.code).toBe("oauth-code");
      expect(resume).toEqual({ nonce: "weather-nonce" });
      return { token: "weather-token" };
    },
  };
  const getWeatherTool: ResolvedToolDefinition = {
    description: "Get the current weather for a city.",
    execute: createToolExecuteWithAuth({
      scope: "get_weather",
      async execute(rawInput, rawCtx) {
        const ctx = rawCtx as ToolContext;
        const token = await ctx.getToken(weatherAuth, {
          authKey: "weather",
          displayName: "Weather",
        });
        const city =
          typeof rawInput === "object" &&
          rawInput !== null &&
          typeof (rawInput as { city?: unknown }).city === "string"
            ? (rawInput as { city: string }).city
            : "Lisbon";
        return {
          city,
          condition: "Sunny",
          summary: `authorized with ${token.token}`,
          temperatureF: 72,
        };
      },
    }),
    inputSchema: toInputSchema({
      additionalProperties: false,
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
      type: "object",
    }),
    logicalPath: "tools/get_weather.ts",
    name: "get_weather",
    owner: { kind: "application" },
    sourceId: "tools/get_weather.ts",
    sourceKind: "module",
  };
  const runtime = await createTestRuntime({
    agent: { name: agentName },
    modules,
    tools: [getWeatherTool],
  });
  const manifestTool = runtime.manifest.tools.find((tool) => tool.name === getWeatherTool.name);
  if (manifestTool === undefined) {
    throw new Error("Expected get_weather to be present in the test manifest.");
  }
  runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
    default: {
      execute: getWeatherTool.execute,
    },
  };
  return {
    completeCalls: () => completeCalls,
    completedPrincipals: () => completedPrincipals,
    runtime,
  };
}

function authorizationAttemptId(events: readonly MessageStreamEvent[]): string {
  const required = filterEventsByType(events, "authorization.required")[0];
  const webhookUrl = required?.data.webhookUrl;
  if (webhookUrl === undefined) throw new Error("Missing authorization callback URL.");
  const segments = new URL(webhookUrl).pathname.split("/");
  const callbackIndex = segments.lastIndexOf("callback");
  const attemptId = segments[callbackIndex + 1];
  if (callbackIndex === -1 || attemptId === undefined) {
    throw new Error("Authorization callback URL is missing its attempt ID.");
  }
  return decodeURIComponent(attemptId);
}

function userAuth(principalId: string) {
  return {
    attributes: {},
    authenticator: "test-idp",
    issuer: "test-idp",
    principalId,
    principalType: "user" as const,
  };
}

async function startWeatherRun(continuationToken: string) {
  return await start(workflowEntry, [
    {
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      input: { message: "Use the get_weather tool to check the weather in Lisbon." },
      serializedContext: buildSerializedContext({
        auth: userAuth("user-1"),
        channelKind: "http",
        continuationToken,
      }),
    },
  ]);
}

function weatherCallback(attemptId: string, code = "oauth-code") {
  return {
    authorizationCallback: {
      attemptId,
      callback: { method: "GET", params: { code } },
      connectionName: "weather",
    },
  };
}
