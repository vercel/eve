import { describe, expect, it } from "vitest";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { startSessionOwner, waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { AuthorizationDefinition, TokenResult } from "#shared/connection-types.js";
import type { ToolContext } from "#tools/definition.js";
import { toInputSchema } from "#tools/schema.js";

describe("workflowEntry sign-ins", () => {
  it("fails a sign-in when completeAuthorization rejects its callback", async () => {
    const { completeCalls, runtime } = await createWeatherAuthRuntime("workflow-entry-auth-denied");

    await runtime.run(async () => {
      const run = await startWeatherRun("http:workflow-entry-auth-denied");
      const stream = captureEvents(run);

      try {
        const asked = await stream.nextUntil("sign-in", isSignInOpened);
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");

        // The provider redirects back with a denial, which completeAuthorization rejects.
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [weatherCallback(signInId(asked), { error: "access_denied" })],
        });

        const resumed = await stream.nextUntil("resumed turn", isTurnSettled);
        expect(completeCalls()).toBe(1);
        expect(filterEventsByType(resumed, "interaction.settled")).toMatchObject([
          { data: { interactionId: signInId(asked), outcome: "failed", reason: "access_denied" } },
        ]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("runs the call a sign-in was for without asking the model again", async () => {
    const { executions, runtime } = await createWeatherAuthRuntime("workflow-entry-auth-no-reask");

    await runtime.run(async () => {
      const run = await startWeatherRun("http:workflow-entry-auth-no-reask");
      const stream = captureEvents(run);

      try {
        const beforeSignIn = await stream.nextUntil("sign-in", isSignInOpened);
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [weatherCallback(signInId(beforeSignIn))],
        });
        const afterSignIn = await stream.nextUntil("turn after sign-in", isTurnSettled);

        // The call that stopped for sign-in is the call that runs: its sign-in settles with it,
        // and the model is not asked to decide again between them.
        const signedInAt = afterSignIn.findIndex(
          (event) =>
            event.type === "interaction.settled" &&
            event.data.interactionId === signInId(beforeSignIn),
        );
        const resultAt = afterSignIn.findIndex((event) => event.type === "call.settled");
        expect(signedInAt).toBeGreaterThanOrEqual(0);
        expect(resultAt).toBeGreaterThan(signedInAt);
        expect(
          afterSignIn
            .slice(signedInAt, resultAt)
            .filter((event) => event.type === "model.requested"),
          "model calls between the sign-in's settlement and the call's",
        ).toHaveLength(0);

        // One model call asks for the tool, one reads its result.
        const events = [...beforeSignIn, ...afterSignIn];
        expect(
          filterEventsByType(events, "model.requested"),
          "model calls in the turn",
        ).toHaveLength(2);
        expect(filterEventsByType(events, "call.requested")).toHaveLength(1);
        // The tool runs once, with the arguments of the original call.
        expect(executions()).toEqual([{ city: "Lisbon" }]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("settles a sign-in once when two calls in one step wait on it, and runs both", async () => {
    const { executions, runtime } = await createWeatherAuthRuntime("workflow-entry-auth-shared");

    await runtime.run(async () => {
      const run = await startWeatherRun(
        "http:workflow-entry-auth-shared",
        "Call tools in parallel: get_weather, get_forecast",
      );
      const stream = captureEvents(run);

      try {
        const beforeSignIn = await stream.nextUntil("sign-in", isSignInOpened);
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [weatherCallback(signInId(beforeSignIn))],
        });
        const afterSignIn = await stream.nextUntil("turn after sign-in", isTurnSettled);

        const events = [...beforeSignIn, ...afterSignIn];
        expect(events.filter(isSignInOpened)).toHaveLength(1);
        expect(
          filterEventsByType(events, "interaction.settled").filter(
            (event) => event.data.interactionId === signInId(beforeSignIn),
          ),
        ).toMatchObject([{ data: { outcome: "accepted" } }]);
        expect(executions()).toHaveLength(2);
        expect(filterEventsByType(events, "model.requested")).toHaveLength(2);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("answers a message that steers a held sign-in, in the same turn, without asking to sign in again", async () => {
    const continuationToken = "http:workflow-entry-auth-steer-answers";
    const { completeCalls, executions, runtime } = await createWeatherAuthRuntime(
      "workflow-entry-auth-steer-answers",
    );

    await runtime.run(async () => {
      const run = await startWeatherRun(continuationToken);
      const stream = captureEvents(run);

      try {
        const asked = await stream.nextUntil("sign-in", isSignInOpened);
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");

        await waitForHook(
          { runId: run.runId },
          { token: sessionInboxHookToken(continuationToken) },
        );
        await resumeHook(sessionInboxHookToken(continuationToken), {
          auth: userAuth("user-1"),
          kind: "send",
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          payload: { message: "Never mind that, just say hello." },
        });
        // A sign-in nobody completed does not stand between the user and an answer.
        const answered = await stream.nextUntil("answer to the steering message", isTurnSettled);
        expect(filterEventsByType(answered, "interaction.settled")).toMatchObject([
          { data: { interactionId: signInId(asked), outcome: "withdrawn" } },
        ]);
        expect(answered.filter(isSignInOpened)).toHaveLength(0);
        expect(filterEventsByType(answered, "turn.started")).toHaveLength(0);
        expect(filterEventsByType(answered, "turn.settled")).toMatchObject([
          { data: { outcome: "completed" } },
        ]);
        expect(executions()).toEqual([]);
        expect(completeCalls()).toBe(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});

function isSignInOpened(event: SessionStreamEvent): boolean {
  return event.type === "interaction.opened" && event.data.request.kind === "sign-in";
}

function isTurnSettled(event: SessionStreamEvent): boolean {
  return event.type === "turn.settled";
}

/** The sign-in interaction `events` opened, which is its attempt. */
function signInId(events: readonly SessionStreamEvent[]): string {
  const opened = filterEventsByType(events, "interaction.opened").find(
    (event) => event.data.request.kind === "sign-in",
  );
  if (opened === undefined) throw new Error("Expected a sign-in interaction.");
  return opened.data.interactionId;
}

interface WeatherAuthRuntime {
  readonly completeCalls: () => number;
  readonly executions: () => readonly { city: string }[];
  readonly runtime: Awaited<ReturnType<typeof createTestRuntime>>;
}

async function createWeatherAuthRuntime(agentName: string): Promise<WeatherAuthRuntime> {
  let completeCalls = 0;
  const executions: { city: string }[] = [];
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
    async completeAuthorization({ callback, resume }): Promise<TokenResult> {
      completeCalls += 1;
      if (callback.params.error === "access_denied") {
        throw new ConnectionAuthorizationFailedError("weather", {
          reason: "access_denied",
          retryable: false,
        });
      }
      expect(callback.params.code).toBe("oauth-code");
      expect(resume).toEqual({ nonce: "weather-nonce" });
      return { token: "weather-token" };
    },
  };
  // Both tools sign in to the same connection, so one callback serves a step that calls both.
  const weatherTool = (name: string): ResolvedToolDefinition => ({
    description: `${name} for a city.`,
    execute: createToolExecuteWithAuth({
      scope: name,
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
        executions.push({ city });
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
      properties: { city: { type: "string" } },
      required: ["city"],
      type: "object",
    }),
    logicalPath: `tools/${name}.ts`,
    name,
    owner: { kind: "application" },
    sourceId: `tools/${name}.ts`,
    sourceKind: "module",
  });
  const tools = [weatherTool("get_weather"), weatherTool("get_forecast")];
  const runtime = await createTestRuntime({ agent: { name: agentName }, tools });
  for (const tool of tools) {
    const manifestTool = runtime.manifest.tools.find((entry) => entry.name === tool.name);
    if (manifestTool === undefined) {
      throw new Error(`Expected ${tool.name} to be present in the test manifest.`);
    }
    runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
      default: { execute: tool.execute },
    };
  }
  return {
    completeCalls: () => completeCalls,
    executions: () => executions,
    runtime,
  };
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

async function startWeatherRun(
  continuationToken: string,
  message = "Use the get_weather tool to check the weather in Lisbon.",
) {
  return await startSessionOwner(workflowEntry, [
    {
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      input: { message },
      serializedContext: buildSerializedContext({
        auth: userAuth("user-1"),
        channelKind: "http",
        continuationToken,
      }),
    },
  ]);
}

function weatherCallback(
  attemptId: string,
  params: Readonly<Record<string, string>> = { code: "oauth-code" },
) {
  return {
    authorizationCallback: {
      attemptId,
      callback: { method: "GET", params },
      connectionName: "weather",
    },
  };
}
