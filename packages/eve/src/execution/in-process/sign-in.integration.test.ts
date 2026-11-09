import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { Runtime } from "#channel/types.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { defineDynamic } from "#dynamic/definition.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { resumeAuthorizationCallback } from "#execution/legacy-session/authorization.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import {
  address,
  dataField,
  follow,
  recorded,
  replies,
  shape,
  violations,
} from "#internal/testing/in-process-sessions.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { defineTool } from "#tools/definition.js";

// A tool that needs Alice to sign in, in this process as on Workflow: the session asks her with a
// link under the host's callback URL, and the provider's redirect reaches the session through
// eve's callback route, which tries the hosts in this process before Workflow.

const CALLBACK_BASE_URL = "https://alice.example";

const alice = {
  attributes: {},
  authenticator: "test-idp",
  issuer: "test-idp",
  principalId: "alice",
  principalType: "user" as const,
};

const weatherAuth: AuthorizationDefinition<{ nonce: string }> = {
  principalType: "user",
  async getToken() {
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
  async completeAuthorization({ callback, resume }) {
    expect(callback.params.code).toBe("oauth-code");
    expect(resume).toEqual({ nonce: "weather-nonce" });
    return { token: "weather-token" };
  },
};

const model = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) =>
      prompt.some((message) => message.role === "tool")
        ? textStreamResult("Alice, it's sunny in Lisbon.")
        : toolCallsStreamResult([
            {
              input: JSON.stringify({ city: "Lisbon" }),
              toolCallId: "call-weather",
              toolName: "get_weather",
            },
          ]),
    modelId: "in-process-sign-in",
    provider: "eve-test",
  }),
);

const isSignIn = (event: SessionStreamEvent) =>
  event.type === "interaction.opened" && JSON.stringify(event.data).includes('"sign-in"');

describe("sign-in on the in-process host", () => {
  it("asks Alice to sign in at the host's callback URL, and runs the call once she has", async () => {
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "in-process-sign-in",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "The weather in a city.",
              inputSchema: {
                additionalProperties: false,
                properties: { city: { type: "string" } },
                required: ["city"],
                type: "object",
              },
              async execute(input: { readonly city: string }, ctx) {
                const { token } = await ctx.getToken(weatherAuth, { authKey: "weather" });
                return { city: input.city, condition: "Sunny", token };
              },
            }),
          }),
          logicalPath: "tools/get_weather.ts",
        },
      ],
    });
    await test.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const inProcess = createInProcessRuntime(
        { compiledArtifactsSource },
        { callbackBaseUrl: `${CALLBACK_BASE_URL}/` },
      );
      const run = async (runtime: Runtime, token: string) => {
        const sent = await address(runtime, token).send("What's the weather in Lisbon?", {
          auth: alice,
        });
        const asked = await follow(runtime, sent.sessionId, (seen) => seen.some(isSignIn));
        const signIn = asked.find(isSignIn)!;
        // The provider redirects back to eve's callback route, which resumes the session's inbox.
        await resumeAuthorizationCallback(
          sessionInboxHookToken(sessionCommandHookToken(sent.sessionId)),
          {
            kind: "authorization-callback",
            payloads: [
              {
                authorizationCallback: {
                  attemptId: String(dataField(signIn, "interactionId")),
                  callback: { method: "GET", params: { code: "oauth-code" } },
                  connectionName: "weather",
                },
              },
            ],
          },
        );
        await follow(runtime, sent.sessionId, (seen) =>
          seen.some((event) => event.type === "turn.settled"),
        );
        const events = await recorded(runtime, sent.sessionId);
        return { events, signIn, violations: await violations(runtime, sent.sessionId) };
      };
      try {
        const here = await run(inProcess, "alice-sign-in-in-process");
        expect(JSON.stringify(here.signIn.data)).toContain(
          encodeURIComponent(`${CALLBACK_BASE_URL}/`),
        );
        expect(
          here.events.filter((event) => event.type === "call.settled").map((event) => event.data),
        ).toMatchObject([
          { callId: "call-weather", outcome: "completed", output: { token: "weather-token" } },
        ]);
        expect(replies(here.events)).toEqual(["Alice, it's sunny in Lisbon."]);
        expect(here.violations).toEqual([]);
        const deployed = await run(
          createWorkflowRuntime({ compiledArtifactsSource }),
          "alice-sign-in-workflow",
        );
        expect(deployed.violations).toEqual([]);
        // Each host names its own callback URL; the rest is the same.
        const withoutUrls = (events: readonly SessionStreamEvent[]) =>
          shape(events.filter((event) => !isSignIn(event)));
        expect(withoutUrls(here.events)).toEqual(withoutUrls(deployed.events));
      } finally {
        await inProcess.dispose();
      }
    });
  }, 60_000);
});
