import type { HandoffWorkflowEntryInput } from "./entry-input.js";
import type { RunCreatedEventRequest } from "@workflow/world";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session/timeout.js";
import { assert, afterEach, describe, expect, it, vi } from "vitest";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import {
  dehydrateWorkflowArguments,
  hydrateWorkflowArguments,
  hydrateStepReturnValue,
} from "@workflow/core/serialization";

import { createChannelAddress } from "#channel/channel-address.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { waitForParkedTurnStep } from "#internal/testing/session-test-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
} from "#execution/eve-workflow-attributes.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { isEventId } from "#protocol/event-id.js";
import type { ToolContext } from "#tools/definition.js";
import type {
  AuthorizationDefinition,
  ConnectionPrincipal,
  TokenResult,
} from "#shared/connection-types.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { toInputSchema } from "#tools/schema.js";
import { defineHook } from "#public/definitions/hook.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import { SessionTitleKey } from "#context/keys.js";

function buildSerializedContext(overrides: {
  acceptedDeploymentId?: string;
  audience?: "public" | "private" | "unknown";
  auth?: Record<string, unknown>;
  channelKind: string;
  channelState?: Record<string, unknown>;
  continuationToken?: string;
  mode: string;
  parent?: {
    readonly callId: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly turn: {
      readonly id: string;
      readonly sequence: number;
    };
  };
}): Record<string, unknown> {
  const channel: { kind: unknown; state: unknown } = {
    kind: overrides.channelKind,
    state: overrides.channelState ?? {},
  };
  const context: Record<string, unknown> = {
    "eve.auth": overrides.auth ?? null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": channel,
    "eve.mode": overrides.mode,
  };
  if (overrides.audience !== undefined) {
    context[ConversationContextKey.name] = {
      audience: overrides.audience,
      channel: { kind: overrides.channelKind },
      environment: "production",
      mode: overrides.mode,
      principalType: "anonymous",
    };
  }
  if (overrides.acceptedDeploymentId !== undefined) {
    context["eve.channelDelivery"] = {
      acceptedDeploymentId: overrides.acceptedDeploymentId,
      channelKind: overrides.channelKind,
      channelName: "test",
      deliveryId: "delivery-initial",
    };
  }
  if (overrides.continuationToken !== undefined) {
    context["eve.continuationToken"] = overrides.continuationToken;
  }
  if (overrides.parent !== undefined) {
    context["eve.parentSession"] = overrides.parent;
  }
  return context;
}

afterEach(() => {
  vi.unstubAllEnvs();
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
async function createWeatherAuthRuntime(agentName: string): Promise<WeatherAuthRuntime> {
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

function expectSingleTurn(events: readonly MessageStreamEvent[], turnId: string): void {
  expect(filterEventsByType(events, "turn.started")).toHaveLength(1);
  const eventTurnIds = events.flatMap((event) => {
    if (!("data" in event) || typeof event.data !== "object" || event.data === null) return [];
    if (!("turnId" in event.data) || typeof event.data.turnId !== "string") return [];
    return [event.data.turnId];
  });
  expect(eventTurnIds.length).toBeGreaterThan(0);
  expect(new Set(eventTurnIds)).toEqual(new Set([turnId]));
}

describe("workflowEntry integration", () => {
  it("parks before initialization and initializes with the first message identity and title", async () => {
    let initializedSessions = 0;
    let initializedAuth: unknown;
    let initializedInitiator: unknown;
    const runtime = await createTestRuntime({
      agent: { name: "workflow-entry-prewarm" },
      modules: [
        {
          logicalPath: "hooks/initialize-session.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                async "session.started"(_event, ctx) {
                  await ctx.getSandbox();
                  initializedSessions += 1;
                  initializedAuth = ctx.session.auth.current;
                  initializedInitiator = ctx.session.auth.initiator;
                },
              },
            }),
          }),
        },
      ],
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {},
          serializedContext: buildSerializedContext({
            auth: { authenticator: "test", principalId: "mount", principalType: "user" },
            channelKind: "http",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(sessionCommandHookToken(run.runId)) },
        );
        await expectHookClaims(run.runId, [sessionCommandHookToken(run.runId)], {
          turnStarted: false,
        });

        const sessionRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        expect(await sessionRuntime.getStreamTailIndex(run.runId)).toBe(-1);
        expect(initializedSessions).toBe(0);
        for (const kind of ["clear", "compact", "cancel"] as const) {
          await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), { kind });
        }
        const firstAuth = { authenticator: "test", principalId: "alice", principalType: "user" };
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          auth: firstAuth,
          title: "Alice’s first chat",
          kind: "send",
          payload: { message: "Say hello to Alice." },
          turnPolicy: "steer",
        });

        const firstTurn = await stream.nextTurn();
        expect(filterEventsByType(firstTurn, "session.started")).toHaveLength(1);
        expect(initializedSessions).toBe(1);
        expect(initializedAuth).toEqual(firstAuth);
        expect(initializedInitiator).toEqual(firstAuth);
        expect((await (await getWorld()).runs.get(run.runId)).attributes?.["$eve.title"]).toBe(
          "Alice’s first chat",
        );
        expectSingleTurn(firstTurn, "turn_0");
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          auth: { ...firstAuth, principalId: "bob" },
          title: "Do not rename",
          kind: "send",
          payload: { message: "Bob joins the conversation. Greet him briefly." },
        });
        const secondTurn = await stream.nextTurn();
        expect(filterEventsByType(secondTurn, "session.started")).toHaveLength(0);
        expectSingleTurn(secondTurn, "turn_1");
        expect(initializedSessions).toBe(1);
        expect((await (await getWorld()).runs.get(run.runId)).attributes?.["$eve.title"]).toBe(
          "Alice’s first chat",
        );
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("persists model output before settlement when a stream append exceeds the SDK flush window", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-stream-order" } });
    const world = await getWorld();
    const append = world.streams.writeMulti!.bind(world.streams);
    let delayedAppend: Promise<void> | undefined;
    const write = vi.spyOn(world.streams, "writeMulti").mockImplementation(async (...args) => {
      if (args[1].endsWith("_user") && delayedAppend === undefined) {
        delayedAppend = new Promise((resolve) => setTimeout(resolve, 1_200));
        await delayedAppend;
      }
      return await append(...args);
    });
    try {
      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: "Say hello to Alice." },
            serializedContext: buildSerializedContext({
              channelKind: "http",
              mode: "conversation",
            }),
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const events = await stream.nextTurn();
          expect(delayedAppend).toBeDefined();
          expect(filterEventsByType(events, "message.completed")).toHaveLength(1);
          expectSingleTurn(events, "turn_0");
          expect(events.at(-1)?.type).toBe("session.waiting");
        } finally {
          await delayedAppend;
          stream.dispose();
          await run.cancel();
        }
      });
    } finally {
      write.mockRestore();
    }
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
            mode: "conversation",
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

        // The authorization park closes its turn boundary so stream
        // consumers do not hang on the parked turn.
        const parkBoundary = await stream.nextUntil(
          "authorization park boundary",
          (event) => event.type === "session.waiting",
        );
        expect(parkBoundary.at(-1)?.type).toBe("session.waiting");
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
        expectSingleTurn(authorizedTurn, "turn_1");
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

  it("runs ordinary deliveries while an authorization challenge stays open", async () => {
    const { completeCalls, completedPrincipals, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-auth-open",
    );
    const continuationToken = "http:workflow-entry-auth-open";

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
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial auth-required event",
          (event) => event.type === "authorization.required",
        );
        // Consume the park's own turn boundary so the next wait delimits
        // the intervening message turn.
        await stream.nextUntil(
          "authorization park boundary",
          (event) => event.type === "session.waiting",
        );

        // An ordinary message while the challenge is open runs as a normal
        // turn instead of queueing behind the callback.
        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          auth: {
            attributes: {},
            authenticator: "test-idp",
            issuer: "test-idp",
            principalId: "user-2",
            principalType: "user",
          },
          kind: "send",
          payload: { message: "Quick status note while I sign in." },
        });

        const interveningTurn = await stream.nextUntil(
          "intervening message turn",
          (event) => event.type === "session.waiting",
        );
        expect(
          interveningTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("Quick status note while I sign in.") === true,
          ),
        ).toBe(true);
        expect(filterEventsByType(interveningTurn, "authorization.completed")).toHaveLength(0);
        expect(completeCalls()).toBe(0);

        // The callback still lands on the retained read and closes the
        // challenge exactly once.
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

        const callbackTurn = await stream.nextUntil(
          "authorization callback turn",
          (event) => event.type === "session.waiting",
        );
        const completed = filterEventsByType(callbackTurn, "authorization.completed");
        expectSingleTurn(callbackTurn, "turn_2");
        expect(completed).toHaveLength(1);
        expect(completed[0]?.data).toMatchObject({
          name: "weather",
          outcome: "authorized",
        });

        // The granted authorization serves the next explicit tool request.
        // (No waitForHook here: it only reports never-received hooks, and
        // the continuation hook already received the intervening message.)
        await resumeHook(sessionInboxHookToken(continuationToken), {
          auth: {
            attributes: {},
            authenticator: "test-idp",
            issuer: "test-idp",
            principalId: "user-1",
            principalType: "user",
          },
          kind: "send",
          payload: { message: "Use the get_weather tool to check the weather in Lisbon." },
        });

        const toolTurn = await stream.nextUntil(
          "post-authorization tool turn",
          (event) => event.type === "session.waiting",
        );
        expect(completeCalls()).toBe(1);
        expect(completedPrincipals()).toEqual([
          expect.objectContaining({ id: "user-1", type: "user" }),
        ]);
        expect(
          toolTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("Used local weather tool for Lisbon") === true &&
              event.data.message.includes("authorized with weather-token"),
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("defers ordinary deliveries while a task waits for authorization", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-task-auth-open",
    );
    const continuationToken = "http:workflow-entry-task-auth-open";

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
            mode: "task",
          }),
        },
      ]);
      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial task auth-required event",
          (event) => event.type === "authorization.required",
        );

        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          kind: "send",
          payload: { message: "This must not become a second task turn." },
        });
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId: authorizationAttemptId(firstTurn),
                callback: { method: "GET", params: { code: "oauth-code" } },
                connectionName: "weather",
              },
            },
          ],
        });

        const completion = await stream.nextUntil(
          "authorized task completion",
          (event) => event.type === "session.completed",
        );
        const allEvents = [...firstTurn, ...completion];
        expect(filterEventsByType(allEvents, "turn.started")).toHaveLength(1);
        expect(filterEventsByType(allEvents, "message.received")).toHaveLength(1);
        expect(filterEventsByType(allEvents, "authorization.completed")).toHaveLength(1);
        expect(filterEventsByType(allEvents, "session.waiting")).toHaveLength(0);
        expect(completeCalls()).toBe(1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("ignores stale and duplicate callbacks after a challenge is replaced", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-auth-replaced",
    );
    const continuationToken = "http:workflow-entry-auth-replaced";

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
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureEvents(run);

      try {
        const firstAttempt = await stream.nextUntil(
          "first auth-required event",
          (event) => event.type === "authorization.required",
        );
        await stream.nextUntil(
          "first authorization park",
          (event) => event.type === "session.waiting",
        );

        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          kind: "send",
          payload: { message: "Use the get_weather tool to check the weather in Lisbon." },
        });
        const replacementAttempt = await stream.nextUntil(
          "replacement auth-required event",
          (event) => event.type === "authorization.required",
        );
        expect(filterEventsByType(replacementAttempt, "authorization.completed")).toMatchObject([
          { data: { name: "weather", outcome: "failed" } },
        ]);
        await stream.nextUntil(
          "replacement authorization park",
          (event) => event.type === "session.waiting",
        );

        const stalePayload = {
          authorizationCallback: {
            attemptId: authorizationAttemptId(firstAttempt),
            callback: { method: "GET", params: { code: "stale-oauth-code" } },
            connectionName: "weather",
          },
        };
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [stalePayload],
        });
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [stalePayload],
        });

        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [
            {
              authorizationCallback: {
                attemptId: authorizationAttemptId(replacementAttempt),
                callback: { method: "GET", params: { code: "oauth-code" } },
                connectionName: "weather",
              },
            },
          ],
        });

        const callbackTurn = await stream.nextUntil(
          "replacement authorization callback turn",
          (event) => event.type === "session.waiting",
        );
        expect(filterEventsByType(callbackTurn, "authorization.completed")).toHaveLength(1);
        expect(completeCalls()).toBe(1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes the challenge after a no-op cancel consumed the parked wait", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime("workflow-entry-auth-cancel");
    const continuationToken = "http:workflow-entry-auth-cancel";

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
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "initial auth-required event",
          (event) => event.type === "authorization.required",
        );
        await stream.nextUntil(
          "authorization park boundary",
          (event) => event.type === "session.waiting",
        );

        await waitForParkedTurnStep(run.runId);

        // A cancel with no active turn is consumed by the parked wait
        // without producing a parent turn. The callback must still surface
        // in the continued wait instead of stalling until unrelated
        // session activity re-parks the owner.
        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), { kind: "cancel" });
        // Let the owner consume the no-op cancel and re-enter the parked
        // wait before the callback fires; back-to-back resumes could
        // otherwise surface the callback in the first wait iteration and
        // mask a wait that ignores callbacks after a consumed cancel.
        await new Promise((resolve) => setTimeout(resolve, 250));

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

        const callbackTurn = await stream.nextUntil(
          "authorization callback turn",
          (event) => event.type === "session.waiting",
        );
        const completed = filterEventsByType(callbackTurn, "authorization.completed");

        expect(completeCalls()).toBe(1);
        expect(completed).toHaveLength(1);
        expect(completed[0]?.data).toMatchObject({
          name: "weather",
          outcome: "authorized",
        });
        expect(filterEventsByType(callbackTurn, "turn.cancelled")).toHaveLength(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("parks in conversation mode and resumes via runtime delivery", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-conversation" } });
    const continuationToken = "http:workflow-entry-conversation";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            acceptedDeploymentId: "dpl_inline",
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureTurnEvents(run);
      let completed = false;
      const hook = await waitForHook(
        { runId: run.runId },
        {
          token: sessionInboxHookToken(continuationToken),
        },
      );

      try {
        const firstTurn = await stream.nextTurn();

        expect(hook.token).toBe(sessionInboxHookToken(continuationToken));
        expect(firstTurn.at(-1)).toMatchObject({
          data: { continuationToken: "workflow-entry-conversation" },
          type: "session.waiting",
        });
        expect(firstTurn.every((event) => typeof event.meta?.at === "string")).toBe(true);
        expect(
          firstTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("hello there") === true,
          ),
        ).toBe(true);

        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        await expect(
          workflowRuntime.dispatchContinuation({
            command: {
              auth: null,
              delivery: {
                acceptedDeploymentId: "dpl_inline",
                channelKind: "http",
                channelName: "test",
                deliveryId: "delivery-followup",
              },
              kind: "send",
              payload: { message: "follow up" },
            },
            continuationToken,
          }),
        ).resolves.toEqual({
          deliveryId: "delivery-followup",
          sessionId: run.runId,
          status: "accepted",
        });

        const secondTurn = await stream.nextTurn();

        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
        expect(secondTurn.every((event) => typeof event.meta?.at === "string")).toBe(true);
        expect(
          secondTurn.every((event) => event.meta?.deliveryIds?.includes("delivery-followup")),
        ).toBe(true);
        expect(
          secondTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up") === true,
          ),
        ).toBe(true);

        await workflowRuntime.dispatchSession({
          command: { kind: "reset", reason: "Test step inventory" },
          sessionId: run.runId,
        });
        await expect(run.returnValue).resolves.toEqual({ output: "" });
        completed = true;
        expect(await listCallerStepNames(run.runId)).toEqual([]);
      } finally {
        stream.dispose();
        if (!completed) await run.cancel();
      }
    });
  });

  it("publishes the session ID as the waiting address for an ID-only session", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-id-only" } });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        expect((await stream.nextTurn()).at(-1)).toMatchObject({
          data: { continuationToken: run.runId },
          type: "session.waiting",
        });
        await expectHookClaims(run.runId, [sessionCommandHookToken(run.runId)]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("stamps every stream event with an id that survives a rewind", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-event-ids" } });
    const continuationToken = "http:workflow-entry-event-ids";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "identify these events" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      let firstTurn: readonly MessageStreamEvent[];
      try {
        firstTurn = await stream.nextTurn();
      } finally {
        stream.dispose();
      }

      try {
        expect(firstTurn.length).toBeGreaterThan(1);
        // No two events share an id, including appends that share
        // `(turnId, sequence, stepIndex)`.
        expect(firstTurn.every((event) => isEventId(event.meta.id))).toBe(true);
        expect(new Set(firstTurn.map((event) => event.meta.id)).size).toBe(firstTurn.length);

        // No stream-order assertion on the ids: they sort in mint order per
        // process, but a turn's events are appended by separate steps whose
        // writes can interleave behind minting (see #protocol/event-id.js),
        // so append order is not contractually sorted.
        const ids = firstTurn.map((event) => event.meta.id);

        // Re-reading the durable stream returns the same ids.
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        const replayed = await workflowRuntime.getEventStream(run.runId, { startIndex: 0 });
        const replayedIds: string[] = [];
        const reader = replayed.getReader();
        try {
          while (replayedIds.length < firstTurn.length) {
            const { done, value } = await reader.read();
            if (done) break;
            replayedIds.push(value.meta.id);
          }
        } finally {
          await reader.cancel();
        }

        // Order is not contractual across separate steps (see comment above):
        // compare membership and count, not append order.
        expect(replayedIds).toHaveLength(ids.length);
        expect(new Set(replayedIds)).toEqual(new Set(ids));
      } finally {
        await run.cancel();
      }
    });
  });

  it("completes an expired conversation and lets its channel start a fresh session", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-timeout" } });
    const continuationToken = "http:workflow-entry-timeout";
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
          sessionTimeoutMs: 25,
        },
      ]);
      const stream = captureEvents(run);
      let replacementSessionId: string | undefined;

      try {
        const events = await stream.nextUntil(
          "session completion",
          (event) => event.type === "session.completed",
        );

        expect(events.some((event) => event.type === "session.waiting")).toBe(true);
        expect(events.at(-1)?.type).toBe("session.completed");
        expect(isEventId(events.at(-1)?.meta.id ?? "")).toBe(true);
        expect(filterEventsByType(events, "session.failed")).toHaveLength(0);
        await expect(run.returnValue).resolves.toEqual({ output: "" });

        const replacement = await createChannelAddress({
          adapter: { kind: "http" },
          channelName: "http",
          continuationToken: "workflow-entry-timeout",
          runtime: workflowRuntime,
        }).send("start fresh", {
          auth: null,
        });
        replacementSessionId = replacement.id;

        expect(replacement.id).not.toBe(run.runId);
        await waitForHook(
          { runId: replacement.id },
          {
            token: sessionInboxHookToken(continuationToken),
          },
        );
      } finally {
        stream.dispose();
        if (replacementSessionId !== undefined) {
          await workflowRuntime.dispatchSession({
            command: { kind: "reset", reason: "Test cleanup" },
            sessionId: replacementSessionId,
          });
        }
      }
    });
  });

  it("notifies each delegated conversation turn and remains available via agentId", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "workflow-entry-delegated-conversation" },
    });
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const childContinuationToken = "subagent:parent-session:call-1";

    await runtime.run(async () => {
      const child = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "delegated first turn" },
          serializedContext: buildSerializedContext({
            channelKind: "subagent",
            channelState: {
              callId: "call-1",
              parentContinuationToken: sessionInboxHookToken(childContinuationToken),
              parentSessionId: "parent-session",
              subagentName: "researcher",
            },
            continuationToken: childContinuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(child);

      try {
        const firstTurn = await withTimeout(stream.nextTurn(), "delegated first turn");
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");
        await expect(waitForRuntimeActionResult(child.runId, "call-1")).resolves.toMatchObject({
          kind: "runtime-action-result",
          results: [
            {
              callId: "call-1",
              kind: "subagent-result",
              output: expect.stringContaining("delegated first turn"),
              subagentName: "researcher",
            },
          ],
        });

        await expect(
          workflowRuntime.dispatchSession({
            command: {
              caller: {
                callId: "call-2",
                replyTo: { kind: "hook", token: sessionInboxHookToken(childContinuationToken) },
                subagentName: "researcher",
              },
              kind: "send",
              payload: { message: "delegated follow-up turn" },
            },
            sessionId: child.runId,
          }),
        ).resolves.toEqual({
          sessionId: child.runId,
          status: "accepted",
        });

        const secondTurn = await withTimeout(stream.nextTurn(), "delegated follow-up turn");
        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
        await expect(waitForRuntimeActionResult(child.runId, "call-2")).resolves.toMatchObject({
          kind: "runtime-action-result",
          results: [
            {
              callId: "call-2",
              kind: "subagent-result",
              output: expect.stringContaining("delegated follow-up turn"),
              subagentName: "researcher",
            },
          ],
        });
        expect(await listCallerStepNames(child.runId)).toEqual([
          "bindTurnCallerContextStep",
          "bindTurnCallerContextStep",
          "notifyTurnCallerStep",
          "notifyTurnCallerStep",
          "resolveInitialTurnCallerStep",
        ]);
      } finally {
        stream.dispose();
        await child.cancel();
      }
    });
  });

  it("forwards continued-turn HITL through the rebound caller", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "workflow-entry-delegated-hitl-rebind" },
    });
    const workflowRuntime = createWorkflowRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const firstCallerToken = "subagent:parent-session:call-1";

    await runtime.run(async () => {
      const child = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "delegated first turn" },
          serializedContext: {
            ...buildSerializedContext({
              channelKind: "subagent",
              channelState: {
                callId: "call-1",
                parentContinuationToken: sessionInboxHookToken(firstCallerToken),
                parentSessionId: "parent-session",
                subagentName: "researcher",
              },
              continuationToken: firstCallerToken,
              mode: "conversation",
            }),
            "eve.capabilities": { requestInput: true },
          },
        },
      ]);
      const stream = captureTurnEvents(child);

      try {
        await withTimeout(stream.nextTurn(), "delegated first turn");
        await waitForRuntimeActionResult(child.runId, "call-1");

        await expect(
          workflowRuntime.dispatchSession({
            command: {
              caller: {
                callId: "call-2",
                replyTo: {
                  kind: "hook",
                  token: sessionInboxHookToken(sessionCommandHookToken(child.runId)),
                },
                subagentName: "researcher",
              },
              kind: "send",
              payload: { message: "Use the ask_question tool exactly once to ask for a color." },
            },
            sessionId: child.runId,
          }),
        ).resolves.toEqual({ sessionId: child.runId, status: "accepted" });

        const secondTurn = await withTimeout(stream.nextTurn(), "delegated HITL turn");
        expect(filterEventsByType(secondTurn, "input.requested")).toHaveLength(1);
        await expect(waitForSubagentInputRequest(child.runId, "call-2")).resolves.toMatchObject({
          callId: "call-2",
          kind: "subagent-input-request",
          subagentName: "researcher",
        });
      } finally {
        stream.dispose();
        await child.cancel();
      }
    });
  }, 60_000);

  describe("deployment handoff", () => {
    const followUp = (acceptedDeploymentId: string, message: string, deliveryId: string) => ({
      turnPolicy: "queue" as const,
      auth: null,
      delivery: {
        acceptedDeploymentId,
        channelKind: "http",
        channelName: "test",
        deliveryId,
      },
      kind: "send" as const,
      payload: { message },
    });

    it.each([undefined, 60_000, false] as const)(
      "renews the configured lifetime across handoffs and keeps the original stream (%s)",
      async (sessionTimeoutMs) => {
        const runtime = await createTestRuntime({ agent: { name: "workflow-entry-handoff" } });

        await runtime.run(async () => {
          const anchor = await start(workflowEntry, [
            {
              kind: "initial",
              sessionTimeoutMs,
              ownerDeploymentId: "dpl_a",
              input: { message: "hello from a" },
              serializedContext: buildSerializedContext({
                acceptedDeploymentId: "dpl_a",
                channelKind: "http",
                mode: "conversation",
              }),
            },
          ]);
          const stream = captureTurnEvents(anchor);
          const world = await getWorld();
          const workflowRuntime = createWorkflowRuntime({
            compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
          });
          let completed = false;
          try {
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            await waitForParkedTurnStep(anchor.runId);

            const originalTimer =
              sessionTimeoutMs === false ? undefined : await readSessionTimer(anchor.runId);

            await expect(
              workflowRuntime.dispatchSession({
                command: followUp("dpl_b", "hello from b", "delivery-b"),
                sessionId: anchor.runId,
              }),
            ).resolves.toMatchObject({ sessionId: anchor.runId, status: "accepted" });

            const secondTurn = await stream.nextTurn();
            expect(secondTurn.at(-1)?.type).toBe("session.waiting");
            expect(
              secondTurn.some(
                (event) =>
                  event.type === "message.completed" &&
                  event.data.message?.includes("hello from b") === true,
              ),
            ).toBe(true);

            // The stable inbox now belongs to a successor run; the original run
            // holds only its anchor (plus the SDK's abort-signal hook from its
            // own earlier turn).
            const successor = await waitForCommandHookOwner(
              sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
            );
            expect(successor.runId).not.toBe(anchor.runId);
            const successorTimer =
              sessionTimeoutMs === false ? undefined : await readSessionTimer(successor.runId);
            if (
              sessionTimeoutMs !== false &&
              originalTimer !== undefined &&
              successorTimer !== undefined
            ) {
              expect(successorTimer.deadline.getTime()).toBeGreaterThan(
                originalTimer.deadline.getTime(),
              );
              const owner = await world.runs.get(successor.runId);
              expect(successorTimer.deadline.getTime()).toBeGreaterThanOrEqual(
                (owner.startedAt ?? owner.createdAt).getTime() +
                  (sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
              );
              await vi.waitFor(async () =>
                expect((await world.runs.get(originalTimer.runId)).status).toBe("cancelled"),
              );
            }
            // A timer from the old owner can win its race with cancellation.
            await resumeHook(sessionInboxHookToken(sessionCommandHookToken(anchor.runId)), {
              kind: "session-timeout",
              ownerRunId: anchor.runId,
            });
            // The successor can finish its turn before the old owner resumes
            // from activation and disposes its temporary handoff hook.
            await vi.waitFor(async () => {
              const anchorHooks = await world.hooks.list({ runId: anchor.runId });
              expect(
                anchorHooks.data
                  .map((hook) => hook.token)
                  .filter((token) => !token.startsWith("abrt_")),
              ).toEqual([`${anchor.runId}:anchor`]);
            });

            // A third delivery through the stable session id reaches the successor
            // and still streams on the original run.
            await expect(
              workflowRuntime.dispatchSession({
                command: followUp("dpl_b", "third message", "delivery-c"),
                sessionId: anchor.runId,
              }),
            ).resolves.toMatchObject({ status: "accepted" });
            const thirdTurn = await stream.nextTurn();
            expect(
              thirdTurn.some(
                (event) =>
                  event.type === "message.completed" &&
                  event.data.message?.includes("third message") === true,
              ),
            ).toBe(true);

            if (successorTimer !== undefined) {
              expect(await readSessionTimer(successor.runId)).toEqual(successorTimer);
            }
            await waitForParkedTurnStep(successor.runId, 2);
            await workflowRuntime.dispatchSession({
              command: followUp("dpl_c", "fourth message", "delivery-d"),
              sessionId: anchor.runId,
            });
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            const nextOwner = await waitForCommandHookOwner(
              sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
            );
            expect(nextOwner.runId).not.toBe(successor.runId);
            await vi.waitFor(async () =>
              expect((await world.runs.get(successor.runId)).status).toBe("completed"),
            );
            expect((await world.runs.get(anchor.runId)).status).toBe("running");
            expect(
              (await world.steps.list({ runId: successor.runId })).data.some((step) =>
                step.stepName.endsWith("//signalSessionAnchorStep"),
              ),
            ).toBe(false);
            if (sessionTimeoutMs !== false && successorTimer !== undefined) {
              const nextTimer = await readSessionTimer(nextOwner.runId);
              const owner = await world.runs.get(nextOwner.runId);
              expect(nextTimer.deadline.getTime()).toBeGreaterThan(
                successorTimer.deadline.getTime(),
              );
              expect(nextTimer.deadline.getTime()).toBeGreaterThanOrEqual(
                (owner.startedAt ?? owner.createdAt).getTime() +
                  (sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
              );
              await vi.waitFor(async () =>
                expect((await world.runs.get(successorTimer.runId)).status).toBe("cancelled"),
              );
            } else {
              for (const runId of [anchor.runId, successor.runId, nextOwner.runId]) {
                const steps = await world.steps.list({ runId });
                expect(
                  steps.data.some((step) => step.stepName.endsWith("//startSessionTimeoutStep")),
                ).toBe(false);
              }
            }

            await waitForParkedTurnStep(nextOwner.runId);
            await workflowRuntime.dispatchSession({
              command: followUp("dpl_d", "fifth message", "delivery-e"),
              sessionId: anchor.runId,
            });
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            const finalOwner = await waitForCommandHookOwner(
              sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
            );
            expect(finalOwner.runId).not.toBe(nextOwner.runId);
            await vi.waitFor(async () =>
              expect((await world.runs.get(nextOwner.runId)).status).toBe("completed"),
            );
            expect((await world.runs.get(anchor.runId)).status).toBe("running");
            expect(
              (await world.steps.list({ runId: nextOwner.runId })).data.some((step) =>
                step.stepName.endsWith("//signalSessionAnchorStep"),
              ),
            ).toBe(false);

            // Reset ends the session on the final owner; the anchor closes the stream once.
            await workflowRuntime.dispatchSession({
              command: { kind: "reset", reason: "handoff test" },
              sessionId: anchor.runId,
            });
            await expect(anchor.returnValue).resolves.toEqual({ output: "" });
            completed = true;
            expect(await listCallerStepNames(anchor.runId)).toEqual([]);
          } finally {
            stream.dispose();
            if (!completed) await anchor.cancel();
          }
        });
      },
    );

    it.each(["nested state", "checkpoint version"] as const)(
      "recovers the original owner when target rejects %s",
      async (incompatibility) => {
        const runtime = await createTestRuntime({ agent: { name: "handoff-validation" } });
        await runtime.run(async () => {
          const anchor = await start(workflowEntry, [
            {
              kind: "initial",
              ownerDeploymentId: "dpl_a",
              sessionTimeoutMs: false,
              input: { message: "Alice opens a research session." },
              serializedContext: buildSerializedContext({
                acceptedDeploymentId: "dpl_a",
                channelKind: "http",
                mode: "conversation",
              }),
            },
          ]);
          const stream = captureTurnEvents(anchor);
          const world = await getWorld();
          const workflowRuntime = createWorkflowRuntime({
            compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
          });
          const rewritten = new Map<string, Promise<unknown>>();
          let candidateId: string | undefined;
          // Model a value readable by the source but incompatible with the target.
          // Only the candidate snapshot changes; the source retains its healthy state.
          const incompatibleInput = (runId: string, encoded: unknown): Promise<unknown> => {
            let pending = rewritten.get(runId);
            if (pending === undefined) {
              pending = (async () => {
                const args = (await hydrateWorkflowArguments(encoded, runId, undefined)) as [
                  HandoffWorkflowEntryInput,
                ];
                expect(args[0].kind).toBe("handoff");
                candidateId = runId;
                const session = args[0].checkpoint.sessionState.snapshot.session;
                if (incompatibility === "checkpoint version") {
                  Object.assign(args[0].checkpoint, { version: 4 });
                } else {
                  Object.assign(session, {
                    state: {
                      ...session.state,
                      "eve.workflowTool": {
                        version: 3,
                        runs: [
                          {
                            callId: "task",
                            toolName: "research",
                            lifetime: "session" as const,
                            origin: { turnId: "turn", stepIndex: 0 },
                            address: { runId: "run", hookToken: 42 },
                            task: {
                              taskId: "task",
                              metadata: { kind: "tool", name: "research" },
                              outcome: {
                                status: "cancelled",
                              },
                              dispatchContext: { auth: { current: null, initiator: null } },
                            },
                          },
                        ],
                      },
                    },
                  });
                }
                const operations: Promise<void>[] = [];
                const result = await dehydrateWorkflowArguments(args, runId, undefined, operations);
                await Promise.all(operations);
                return result;
              })();
              rewritten.set(runId, pending);
            }
            return pending;
          };
          const createEvent = world.events.create.bind(world.events);
          const created = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
            const [runId] = args;
            const event = args[1] as (typeof args)[1] | RunCreatedEventRequest;
            if (event.eventType === "run_created" && event.eventData.deploymentId === "dpl_b") {
              event.eventData.input = await incompatibleInput(runId, event.eventData.input);
            }
            return createEvent(...args);
          });
          const queue = world.queue.bind(world);
          const queued = vi.spyOn(world, "queue").mockImplementation(async (...args) => {
            const message = args[1] as {
              runId?: string;
              runInput?: { deploymentId?: string; input: unknown };
            };
            if (message.runId !== undefined && message.runInput?.deploymentId === "dpl_b") {
              message.runInput.input = await incompatibleInput(
                message.runId,
                message.runInput.input,
              );
            }
            return queue(...args);
          });
          try {
            await stream.nextTurn();
            await workflowRuntime.dispatchSession({
              command: followUp(
                "dpl_b",
                "Bob requests the next research step.",
                "validation-trigger",
              ),
              sessionId: anchor.runId,
            });
            expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
            assert(candidateId !== undefined);
            expect(
              (
                await waitForCommandHookOwner(
                  sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
                )
              ).runId,
            ).toBe(anchor.runId);
            expect(
              created.mock.calls.some(
                ([runId, event]) => runId === candidateId && event.eventType === "hook_created",
              ),
            ).toBe(false);
            const candidateHooks = await world.hooks.list({ runId: candidateId });
            expect(candidateHooks.data).toEqual([]);
            const turns = await vi.waitFor(
              async () => {
                const steps = await world.steps.list({ runId: anchor.runId, resolveData: "all" });
                const turns = steps.data.filter((step) => step.stepName.endsWith("//turnStep"));
                expect(turns).toHaveLength(2);
                // The waiting event is streamed before the step's return value is persisted.
                expect(turns.every((step) => step.output !== undefined)).toBe(true);
                return turns;
              },
              { timeout: 5000 },
            );
            const histories = await Promise.all(
              turns.map(async (step) => {
                const output = await hydrateStepReturnValue(step.output, anchor.runId, undefined);
                return output.sessionState.snapshot.session.history as Array<{
                  role: string;
                  content: unknown;
                }>;
              }),
            );
            const deliveries = histories.map((history) =>
              history.filter(
                (message) =>
                  message.role === "user" &&
                  JSON.stringify(message.content).includes("Bob requests the next research step."),
              ),
            );
            expect(deliveries.map((messages) => messages.length).sort()).toEqual([0, 1]);
          } finally {
            created.mockRestore();
            queued.mockRestore();
            await workflowRuntime.dispatchSession({
              command: { kind: "reset", reason: "validation test" },
              sessionId: anchor.runId,
            });
            await anchor.returnValue;
            stream.dispose();
          }
        });
      },
    );

    it("retains a message accepted just before durable hook disposal", async () => {
      const runtime = await createTestRuntime({ agent: { name: "workflow-entry-handoff" } });

      await runtime.run(async () => {
        const anchor = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_a",
            input: { message: "hello from a" },
            serializedContext: buildSerializedContext({
              acceptedDeploymentId: "dpl_a",
              channelKind: "http",
              mode: "conversation",
            }),
          },
        ]);
        const stream = captureTurnEvents(anchor);
        const world = await getWorld();
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        let injected = false;
        const createEvent = world.events.create.bind(world.events);
        const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
          const [runId, event] = args;
          if (
            !injected &&
            runId === anchor.runId &&
            event.eventType === "hook_disposed" &&
            event.eventData?.token === sessionInboxHookToken(sessionCommandHookToken(anchor.runId))
          ) {
            injected = true;
            for (let index = 0; index < 3; index++) {
              await resumeHook(sessionInboxHookToken(sessionCommandHookToken(anchor.runId)), {
                kind: "send",
                payload: { message: `Alice sends input ${index} during release.` },
                turnPolicy: "queue",
              });
            }
          }
          return await createEvent(...args);
        });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          await waitForParkedTurnStep(anchor.runId);

          await expect(
            workflowRuntime.dispatchSession({
              command: followUp("dpl_b", "hello from b", "delivery-b"),
              sessionId: anchor.runId,
            }),
          ).resolves.toMatchObject({ sessionId: anchor.runId, status: "accepted" });

          const secondTurn = await stream.nextTurn();
          expect(secondTurn.at(-1)?.type).toBe("session.waiting");
          expect(
            secondTurn.some(
              (event) =>
                event.type === "message.completed" &&
                event.data.message?.includes("hello from b") === true,
            ),
          ).toBe(true);

          expect(injected).toBe(true);
          spy.mockRestore();
          const owner = await waitForCommandHookOwner(
            sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
          );
          expect(owner.runId).toBe(anchor.runId);
          await workflowRuntime.dispatchSession({
            command: followUp("dpl_b", "Bob sends a later sentinel.", "sentinel"),
            sessionId: anchor.runId,
          });
          await stream.nextTurn();
          let saved: string | undefined;
          await vi.waitFor(
            async () => {
              const steps = await world.steps.list({
                runId: owner.runId,
                resolveData: "all",
                pagination: { limit: 1000 },
              });
              for (const step of steps.data) {
                if (!step.stepName.endsWith("//turnStep") || step.output === undefined) continue;
                const result = await hydrateStepReturnValue(step.output, owner.runId, undefined);
                const history = JSON.stringify(result.sessionState.snapshot.session.history);
                if (history.includes("Bob sends a later sentinel.")) saved = history;
              }
              expect(saved).toBeDefined();
            },
            { timeout: 5000 },
          );
          for (let index = 0; index < 3; index++) {
            expect(saved).toContain(`Alice sends input ${index} during release.`);
          }
          expect(saved!.indexOf("Alice sends input 0")).toBeLessThan(
            saved!.indexOf("Alice sends input 1"),
          );
          expect(saved!.indexOf("Alice sends input 1")).toBeLessThan(
            saved!.indexOf("Alice sends input 2"),
          );
        } finally {
          spy.mockRestore();
          stream.dispose();
          if ((await anchor.status) === "running") await anchor.cancel();
        }
      });
    });

    it("hands off an alias-addressed session and keeps the alias resolving through the gap", async () => {
      const runtime = await createTestRuntime({ agent: { name: "workflow-entry-handoff-alias" } });
      const continuationToken = "http:workflow-entry-handoff-alias";

      await runtime.run(async () => {
        const anchor = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_a",
            input: { message: "hello from a" },
            serializedContext: buildSerializedContext({
              acceptedDeploymentId: "dpl_a",
              channelKind: "http",
              continuationToken,
              mode: "conversation",
            }),
          },
        ]);
        const stream = captureTurnEvents(anchor);
        const world = await getWorld();
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        // A channel delivery lands on the alias while the old owner has released
        // it and the successor has not yet claimed it. The handoff marker must
        // make ingress wait for the successor instead of reporting the session
        // gone (which would let the channel start a replacement session).
        let gapDelivery: Promise<unknown> | undefined;
        const createEvent = world.events.create.bind(world.events);
        const spy = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
          const [runId, event] = args;
          const created = await createEvent(...args);
          if (
            gapDelivery === undefined &&
            runId === anchor.runId &&
            event.eventType === "hook_disposed" &&
            event.eventData?.token === sessionInboxHookToken(continuationToken)
          ) {
            gapDelivery = workflowRuntime.dispatchContinuation({
              command: followUp("dpl_b", "Alice writes during the gap.", "delivery-gap"),
              continuationToken,
            });
          }
          return created;
        });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");

          await expect(
            workflowRuntime.dispatchContinuation({
              command: followUp("dpl_b", "hello from b", "delivery-b"),
              continuationToken,
            }),
          ).resolves.toMatchObject({ sessionId: anchor.runId, status: "accepted" });

          const secondTurn = await stream.nextTurn();
          expect(
            secondTurn.some(
              (event) =>
                event.type === "message.completed" &&
                event.data.message?.includes("hello from b") === true,
            ),
          ).toBe(true);
          spy.mockRestore();
          expect(gapDelivery).toBeDefined();
          await expect(gapDelivery).resolves.toMatchObject({
            sessionId: anchor.runId,
            status: "accepted",
          });
          const gapTurn = await stream.nextTurn();
          expect(
            gapTurn.some(
              (event) =>
                event.type === "message.completed" &&
                event.data.message?.includes("Alice writes during the gap.") === true,
            ),
          ).toBe(true);

          const successor = await waitForCommandHookOwner(
            sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
          );
          expect(successor.runId).not.toBe(anchor.runId);
          await expect(
            waitForCommandHookOwner(sessionInboxHookToken(continuationToken)),
          ).resolves.toMatchObject({ runId: successor.runId });
          // No marker outlives the handoff.
          const markers = (await world.hooks.list({ runId: anchor.runId })).data.filter((hook) =>
            hook.token.startsWith("eve:inbox:handoff:"),
          );
          expect(markers).toEqual([]);
          // Only one session exists for this alias.
          await expect(workflowRuntime.resolveContinuation(continuationToken)).resolves.toEqual({
            sessionId: anchor.runId,
          });
        } finally {
          stream.dispose();
          await anchor.cancel();
        }
      });
    });

    it("keeps the session on the current owner when it is not idle", async () => {
      const runtime = await createTestRuntime({ agent: { name: "workflow-entry-handoff-busy" } });

      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_a",
            input: { message: "hello from a" },
            serializedContext: buildSerializedContext({
              acceptedDeploymentId: "dpl_a",
              channelKind: "http",
              mode: "conversation",
            }),
          },
        ]);
        const stream = captureTurnEvents(run);
        const workflowRuntime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        try {
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");

          // Two deliveries accepted back to back: the second is pending when the
          // first is evaluated, so neither may trigger a handoff.
          await Promise.all([
            workflowRuntime.dispatchSession({
              command: followUp("dpl_b", "first burst", "delivery-1"),
              sessionId: run.runId,
            }),
            workflowRuntime.dispatchSession({
              command: followUp("dpl_b", "second burst", "delivery-2"),
              sessionId: run.runId,
            }),
          ]);
          const turn = await stream.nextTurn();
          expect(turn.at(-1)?.type).toBe("session.waiting");
          expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");
          const owner = await waitForCommandHookOwner(
            sessionInboxHookToken(sessionCommandHookToken(run.runId)),
          );
          expect(owner.runId).toBe(run.runId);
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    });
  });

  it("exits a competing continuation owner before its first turn", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-hook-owner" } });
    const continuationToken = "http:workflow-entry-hook-owner";

    await runtime.run(async () => {
      const owner = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "owner message" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const ownerStream = captureTurnEvents(owner);
      await waitForHook(
        { runId: owner.runId },
        { token: sessionInboxHookToken(continuationToken) },
      );

      const firstTurn = await ownerStream.nextTurn();
      expect(firstTurn.at(-1)?.type).toBe("session.waiting");

      const contender = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          continuationConflictCommand: {
            auth: null,
            kind: "send",
            payload: { message: "contending message" },
          },
          input: { message: "contending message" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      try {
        await expect(contender.returnValue).resolves.toEqual({ output: "" });
        const ownerFollowUp = await ownerStream.nextTurn();

        expect(ownerFollowUp.at(-1)?.type).toBe("session.waiting");
        expect(
          ownerFollowUp.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("contending message") === true,
          ),
        ).toBe(true);
      } finally {
        ownerStream.dispose();
        await owner.cancel();
      }
    });
  });

  it("emits completed structured results for a conversation turn outputSchema", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-output-schema" } });
    const continuationToken = "http:workflow-entry-output-schema";
    const outputSchema = {
      properties: {
        count: { type: "integer" },
        title: { type: "string" },
      },
      required: ["title", "count"],
      type: "object",
    } as const;

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "summarize this", outputSchema },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureTurnEvents(run);
      await waitForHook(
        { runId: run.runId },
        {
          token: sessionInboxHookToken(continuationToken),
        },
      );

      try {
        const firstTurn = await stream.nextTurn();
        const results = filterEventsByType(firstTurn, "result.completed");

        expect(results).toHaveLength(1);
        expect(results[0]?.data.result).toEqual({
          count: 1,
          title: "structured-output",
        });
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");

        await resumeHook(sessionInboxHookToken(continuationToken), {
          kind: "send",
          payload: { message: "follow up without structured output" },
        });

        const secondTurn = await stream.nextTurn();

        expect(filterEventsByType(secondTurn, "result.completed")).toHaveLength(0);
        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes immediately in task mode", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-task" } });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:workflow-entry-task",
            mode: "task",
          }),
        },
      ]);

      await expect(run.returnValue).resolves.toEqual({
        output: expect.stringContaining("hello there"),
      });
      await expect(run.status).resolves.toBe("completed");
    });
  });

  it("can delete the sandbox from a session.completed hook", async () => {
    let deletions = 0;
    const runtime = await createTestRuntime({
      agent: { name: "workflow-entry-task-delete-sandbox" },
      modules: [
        {
          logicalPath: "hooks/delete-sandbox.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                async "session.completed"(_event, ctx) {
                  const sandbox = await ctx.getSandbox();
                  await sandbox.delete();
                  deletions += 1;
                },
              },
            }),
          }),
        },
      ],
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:workflow-entry-task-delete-sandbox",
            mode: "task",
          }),
        },
      ]);

      await expect(run.returnValue).resolves.toEqual({
        output: expect.stringContaining("hello there"),
      });
      expect(deletions).toBe(1);
    });
  });

  it("returns agent-declared structured output in task mode", async () => {
    const outputSchema = {
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
      type: "object",
    } as const;
    const runtime = await createTestRuntime({
      agent: { name: "workflow-entry-task-output-schema", outputSchema },
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:workflow-entry-task-output-schema",
            mode: "task",
          }),
        },
      ]);

      await expect(run.returnValue).resolves.toEqual({
        output: { summary: "structured-output" },
      });
      await expect(run.status).resolves.toBe("completed");
    });
  });

  it("emits `$eve.*` session attributes onto the parent workflow run", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-tags" } });
    const continuationToken = "http:workflow-entry-tags";

    await runtime.run(async () => {
      const serializedContext = {
        ...buildSerializedContext({
          audience: "public",
          channelKind: "http",
          continuationToken,
          mode: "conversation",
        }),
        [SessionTitleKey.name]: "session tag round-trip",
      };
      const run = await start(
        workflowEntry,
        [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: "session tag round-trip" },
            serializedContext,
          },
        ],
        {
          allowReservedAttributes: true,
          attributes: normalizeEveAttributes(
            buildSessionAttributes({
              serializedContext,
            }),
          ),
        },
      );

      const stream = captureTurnEvents(run);
      try {
        await stream.nextTurn();

        const world = await getWorld();
        const persisted = await world.runs.get(run.runId);
        const attrs = (persisted as { attributes?: Record<string, string> }).attributes ?? {};

        expect(attrs["$eve.type"]).toBe("session");
        expect(attrs["$eve.is_trace_content_visible"]).toBe("true");
        expect(attrs["$eve.trigger"]).toBe("http");
        expect(attrs["$eve.title"]).toContain("session tag round-trip");
        // Top-level sessions have no parent or subagent name on the root run.
        expect(attrs["$eve.parent"]).toBeUndefined();
        expect(attrs["$eve.subagent"]).toBeUndefined();
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("emits parent lineage onto a subagent workflow run", async () => {
    const runtime = await createTestRuntime({ agent: { name: "workflow-entry-subagent-tags" } });

    await runtime.run(async () => {
      const serializedContext = buildSerializedContext({
        audience: "public",
        channelKind: "subagent",
        continuationToken: "subagent:parent-session:call-subagent-1",
        mode: "task",
        parent: {
          callId: "call-subagent-1",
          rootSessionId: "root-session",
          sessionId: "parent-session",
          turn: { id: "turn-parent", sequence: 2 },
        },
      });
      const run = await start(
        workflowEntry,
        [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: "subagent tag round-trip" },
            serializedContext,
          },
        ],
        {
          allowReservedAttributes: true,
          attributes: normalizeEveAttributes(
            buildSubagentRootAttributes({
              identity: { nodeId: "researcher" },
              parentCallId: "call-subagent-1",
              parentSessionId: "parent-session",
              parentTurnId: "turn-parent",
              rootSessionId: "root-session",
              serializedContext,
            }),
          ),
        },
      );

      await expect(run.returnValue).resolves.toEqual({
        output: expect.stringContaining("subagent tag round-trip"),
      });
      await expect(run.status).resolves.toBe("completed");

      const world = await getWorld();
      const persisted = await world.runs.get(run.runId);
      const attrs = (persisted as { attributes?: Record<string, string> }).attributes ?? {};

      expect(attrs["$eve.type"]).toBe("subagent");
      expect(attrs["$eve.is_trace_content_visible"]).toBe("true");
      expect(attrs["$eve.parent"]).toBe("parent-session");
      expect(attrs["$eve.parent_call"]).toBe("call-subagent-1");
      expect(attrs["$eve.parent_turn"]).toBe("turn-parent");
      expect(attrs["$eve.root"]).toBe("root-session");
      expect(attrs["$eve.trigger"]).toBe("subagent");
    });
  });
});

const CALLER_STEP_NAMES = new Set([
  "bindTurnCallerContextStep",
  "notifyTurnCallerStep",
  "resolveInitialTurnCallerStep",
]);

async function listCallerStepNames(runId: string): Promise<string[]> {
  return (await listStepNames(runId)).filter((name) => CALLER_STEP_NAMES.has(name)).sort();
}

async function listStepNames(runId: string): Promise<string[]> {
  const world = await getWorld();
  const steps = await world.steps.list({
    pagination: { limit: 1_000 },
    resolveData: "none",
    runId,
  });
  return steps.data.map((step) => step.stepName.split("//").at(-1) ?? "");
}

interface CapturedEventStream {
  dispose(): void;
  nextUntil(
    label: string,
    predicate: (event: MessageStreamEvent) => boolean,
  ): Promise<MessageStreamEvent[]>;
}

function captureEvents(run: Parameters<typeof captureTurnEvents>[0]): CapturedEventStream {
  const reader = run.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let disposed = false;

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      reader.releaseLock();
    },
    nextUntil(label, predicate) {
      if (disposed) {
        return Promise.reject(new Error("CapturedEventStream: stream already disposed."));
      }
      return withTimeout(readUntil(reader, decoder, buffer, predicate), label).then((result) => {
        buffer = result.buffer;
        return result.events;
      });
    },
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: InstanceType<typeof TextDecoder>,
  initialBuffer: string,
  predicate: (event: MessageStreamEvent) => boolean,
): Promise<{ buffer: string; events: MessageStreamEvent[] }> {
  const events: MessageStreamEvent[] = [];
  let buffer = initialBuffer;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      throw new Error("Workflow stream closed before reaching the expected event.");
    }

    buffer += decoder.decode(value);

    for (
      let newlineIndex = buffer.indexOf("\n");
      newlineIndex !== -1;
      newlineIndex = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      const event = JSON.parse(line) as MessageStreamEvent;
      events.push(event);

      if (predicate(event)) {
        return { buffer, events };
      }
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label}.`));
        }, 30_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function expectHookClaims(
  runId: string,
  tokens: string[],
  options: { readonly turnStarted?: boolean } = {},
): Promise<void> {
  const events = await (
    await getWorld()
  ).events.list({
    runId,
    pagination: { limit: 1000 },
    resolveData: "all",
  });
  const claims = events.data.flatMap((event) =>
    event.eventType === "hook_created" ? [event.eventData.token] : [],
  );
  const signals = claims.filter((token) => token.startsWith("abrt_"));
  expect(signals).toHaveLength(options.turnStarted === false ? 0 : 2);
  expect(claims.filter((token) => !token.startsWith("abrt_")).sort()).toEqual(
    tokens.map(sessionInboxHookToken).sort(),
  );
}

async function waitForRuntimeActionResult(runId: string, callId: string): Promise<unknown> {
  const world = await getWorld();
  const deadline = Date.now() + 10_000;
  let receivedPayloads: unknown[] = [];

  while (Date.now() < deadline) {
    const events = await world.events.list({
      pagination: { limit: 1000 },
      resolveData: "all",
      runId,
    });
    receivedPayloads = [];

    for (const event of events.data) {
      if (event.eventType === "hook_received") {
        const payload = await hydrateWorkflowArguments(event.eventData.payload, runId, undefined);
        receivedPayloads.push(payload);
        if (hasSubagentResult(payload, callId)) {
          return payload;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for delegated result "${callId}". Received: ${JSON.stringify(receivedPayloads)}`,
  );
}

async function waitForSubagentInputRequest(runId: string, callId: string): Promise<unknown> {
  const world = await getWorld();
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const events = await world.events.list({
      pagination: { limit: 1000 },
      resolveData: "all",
      runId,
    });
    for (const event of events.data) {
      if (event.eventType !== "hook_received") continue;
      const payload = await hydrateWorkflowArguments(event.eventData.payload, runId, undefined);
      if (
        typeof payload === "object" &&
        payload !== null &&
        "kind" in payload &&
        payload.kind === "subagent-input-request" &&
        "callId" in payload &&
        payload.callId === callId
      ) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for a subagent input request from caller "${callId}".`);
}

function hasSubagentResult(value: unknown, callId: string): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "runtime-action-result" ||
    !("results" in value) ||
    !Array.isArray(value.results)
  ) {
    return false;
  }

  return value.results.some(
    (result) =>
      typeof result === "object" &&
      result !== null &&
      "callId" in result &&
      result.callId === callId,
  );
}

async function readSessionTimer(ownerRunId: string): Promise<{ runId: string; deadline: Date }> {
  const world = await getWorld();
  let timer: { runId: string; deadline: Date } | undefined;
  await vi.waitFor(async () => {
    const steps = await world.steps.list({ runId: ownerRunId, resolveData: "all" });
    const start = steps.data.find((step) => step.stepName.endsWith("//startSessionTimeoutStep"));
    expect(start?.output).toBeDefined();
    const result = (await hydrateStepReturnValue(start!.output, ownerRunId, undefined)) as {
      runId: string;
    };
    const run = await world.runs.get(result.runId);
    const [input] = (await hydrateWorkflowArguments(run.input, run.runId, undefined)) as [
      { deadline: Date },
    ];
    timer = { runId: run.runId, deadline: input.deadline };
  });
  return timer!;
}
