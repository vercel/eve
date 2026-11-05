import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import type { ActivationOutcome } from "#execution/entity/entities.js";
import { resumeAuthorizationCallback } from "#execution/legacy-session/authorization.js";
import { authHookToken } from "#harness/authorization.js";
import { localWorld } from "#execution/world/local-world.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { defineTool } from "#tools/definition.js";
import { createWorldHost, type WorldHost } from "./host.js";

// A tool that needs Alice to sign in, on a World host: the session asks her with a link under the
// host's callback URL and stops while it waits; the provider's redirect reaches eve's callback
// route in whichever process serves it, which sends it to the session's entity, and the session
// runs the call in its next activation.

const CALLBACK_BASE_URL = "https://alice.example";

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
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

const isSignIn = (event: SessionStreamEvent) =>
  event.type === "interaction.opened" && JSON.stringify(event.data).includes('"sign-in"');

let dir: string;
let host: WorldHost | undefined;
const outcomes: { sessionId: string; outcome: ActivationOutcome }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eve-world-host-sign-in-"));
  outcomes.length = 0;
});
afterEach(async () => {
  await host?.close();
  await host?.world.close?.();
  host = undefined;
  rmSync(dir, { force: true, recursive: true });
});

async function until(condition: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The session's events, read from the World until `done` holds for them. */
async function eventsUntil(
  events: ReadableStream<SessionStreamEvent>,
  done: (seen: readonly SessionStreamEvent[]) => boolean,
): Promise<SessionStreamEvent[]> {
  const reader = events.getReader();
  const seen: SessionStreamEvent[] = [];
  try {
    while (!done(seen)) {
      const next = await reader.read();
      if (next.done) break;
      seen.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return seen;
}

/** Whether the newest activation stopped idle: nothing runs the session now. */
const lastIdle = () => outcomes.at(-1)?.outcome.kind === "idle";

describe("sign-in on a World host", () => {
  it("asks Alice at the host's callback URL, stops while she signs in, and runs the call after", async () => {
    const ran: unknown[] = [];
    const agent = defineAgent({
      model: markMockModel(
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
          modelId: "world-host-sign-in",
          provider: "eve-test",
        }),
      ),
      modelContextWindowTokens: 200_000,
      name: "weather",
      tools: {
        get_weather: defineTool({
          description: "The weather in a city.",
          inputSchema: {
            additionalProperties: false,
            properties: { city: { type: "string" } },
            required: ["city"],
            type: "object",
          },
          async execute(input: { readonly city: string }, ctx) {
            const { token } = await ctx.getToken(weatherAuth, { authKey: "weather" });
            ran.push(token);
            return { city: input.city, condition: "Sunny", token };
          },
        }),
      },
    });
    host = createWorldHost({
      agents: [agent],
      callbackBaseUrl: CALLBACK_BASE_URL,
      observe: ({ outcome, sessionId }) => outcomes.push({ outcome, sessionId }),
      world: localWorld({ dataDir: join(dir, "world") }),
    });
    await host.serve();
    const session = host.session("weather", { identity: alice });
    const sent = await session.send("What's the weather in Lisbon?");

    const asked = await eventsUntil(await session.events(), (seen) => seen.some(isSignIn));
    const signIn = asked.find(isSignIn)!;
    expect(JSON.stringify(signIn.data)).toContain(encodeURIComponent(CALLBACK_BASE_URL));
    // Nothing holds the session while Alice signs in.
    await until(() => outcomes.some((entry) => entry.outcome.kind === "idle"));
    expect(ran).toEqual([]);

    // The provider redirects to eve's callback route, which resumes the session's address.
    const activations = outcomes.length;
    await resumeAuthorizationCallback(authHookToken(sent.sessionId), {
      kind: "authorization-callback",
      payloads: [
        {
          authorizationCallback: {
            attemptId: String((signIn.data as { interactionId?: unknown }).interactionId),
            callback: { method: "GET", params: { code: "oauth-code" } },
            connectionName: "weather",
          },
        },
      ],
    });
    const completed = (event: SessionStreamEvent) =>
      event.type === "call.settled" &&
      (event.data as { outcome?: unknown }).outcome === "completed";
    const settled = await eventsUntil(await session.events(), (seen) => seen.some(completed));
    await until(() => outcomes.length > activations && lastIdle());
    // It ran in an activation the callback started, with the token the sign-in gave.
    expect(ran).toEqual(["weather-token"]);
    expect(
      settled.filter((event) => event.type === "call.settled").map((event) => event.data),
    ).toMatchObject([
      { callId: "call-weather", outcome: "completed", output: { token: "weather-token" } },
    ]);
  }, 60_000);
});
