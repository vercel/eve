import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { defineDynamic } from "#dynamic/definition.js";
import { resumeAuthorizationCallback } from "#execution/legacy-session/authorization.js";
import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { readSessionEventHistory } from "#execution/session-event-stream.js";
import { parseEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import type { AuthorizationDefinition, TokenResult } from "#shared/connection-types.js";
import { defineTool } from "#tools/definition.js";

// A parent runs three children at once, and each child's tool needs a Weather sign-in for the
// same person. The sign-ins relay to the parent, which shows a card for each one it can't serve
// with a card it already shows. The authorization provider is faked at its edge.

vi.setConfig({ testTimeout: 90_000 });

const CHILDREN = 3;

const ALICE = {
  attributes: {},
  authenticator: "test-idp",
  issuer: "test-idp",
  principalId: "alice",
  principalType: "user" as const,
};

describe("sign-ins relayed by parallel children", () => {
  it("shows one card for children asking for the same Connect grant, and completing it runs every child's call", async () => {
    const app = await createApp("joined-sign-ins-shared", { grant: "oauth/weather" });

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const before = await stream.nextUntil("first sign-in card", isSignInOpened);
        await waitForRelays(run.runId, CHILDREN);
        // Every child has asked by now, and the parent shows one card for all three.
        expect(
          (await history(run.runId)).filter(isSignInOpened),
          "sign-in cards once every child asked",
        ).toHaveLength(1);

        const [card] = before.filter(isSignInOpened);
        await completeSignIn(card!, { code: "oauth-code" });
        const after = await stream.nextUntil("parent turn", isTurnSettled);

        const events = [...before, ...after];
        expect(events.filter(isSignInOpened), "sign-in cards in the parent").toHaveLength(1);
        expect(app.starts(), "sign-ins the children started").toBe(CHILDREN);
        expect(app.completes(), "sign-ins the children completed").toBe(CHILDREN);
        expect(app.executions().toSorted()).toEqual(["Lisbon 0", "Lisbon 1", "Lisbon 2"]);
        expect(
          filterEventsByType(events, "interaction.settled")
            .filter((event) => event.data.interactionId === signInId(card!))
            .map((event) => event.data.outcome),
        ).toEqual(["accepted"]);
        expect(filterEventsByType(events, "turn.settled").map((e) => e.data.outcome)).toEqual([
          "completed",
        ]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("shows a card for each child when the sign-ins carry no grant", async () => {
    const app = await createApp("joined-sign-ins-no-grant", {});

    await app.runtime.run(async () => {
      const run = await startParent(app.name);
      const stream = captureEvents(run);
      try {
        const events: SessionStreamEvent[] = [];
        for (let shown = 0; shown < CHILDREN; shown += 1)
          events.push(...(await stream.nextUntil(`sign-in card ${shown}`, isSignInOpened)));
        const cards = events.filter(isSignInOpened);
        expect(cards, "sign-in cards in the parent").toHaveLength(CHILDREN);

        // Each card completes only its own child's sign-in.
        for (const card of cards) await completeSignIn(card, { code: "oauth-code" });
        events.push(...(await stream.nextUntil("parent turn", isTurnSettled)));

        expect(events.filter(isSignInOpened)).toHaveLength(CHILDREN);
        expect(app.completes()).toBe(CHILDREN);
        expect(app.executions().toSorted()).toEqual(["Lisbon 0", "Lisbon 1", "Lisbon 2"]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});

type Prompt = LanguageModelV4CallOptions["prompt"];

/**
 * The parent starts three children in one step and waits for their reports. A child, whose
 * conversation starts with the parent's message, checks the weather and reports.
 */
function scriptedModel() {
  let waits = 0;
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }: { prompt: Prompt }) => {
        const raw = JSON.stringify(prompt);
        const called = (tool: string) => raw.includes(`"toolName":"${tool}"`);
        const first = JSON.stringify(prompt.find((message) => message.role === "user")?.content);
        const child = /CHILD (\d)/u.exec(first)?.[1];
        if (child !== undefined) {
          return called("get_weather")
            ? textStreamResult(`Weather report ${child} ready.`)
            : toolCallsStreamResult([
                {
                  input: JSON.stringify({ city: `Lisbon ${child}` }),
                  toolCallId: `call_weather_${child}`,
                  toolName: "get_weather",
                },
              ]);
        }
        if (!called("agent"))
          return toolCallsStreamResult(
            Array.from({ length: CHILDREN }, (_, index) => ({
              input: JSON.stringify({ message: `CHILD ${index}: check the weather in Lisbon.` }),
              toolCallId: `call_agent_${index}`,
              toolName: "agent",
            })),
          );
        const reports = raw.match(/Weather report \d ready/gu)?.length ?? 0;
        if (reports < CHILDREN) {
          if (waits > 20) throw new Error("The parent kept waiting for its children.");
          return toolCallsStreamResult([
            { input: "{}", toolCallId: `call_wait_${waits++}`, toolName: "eve__task_wait" },
          ]);
        }
        return textStreamResult("Every child reported.");
      },
      modelId: "scripted",
      provider: "eve-test",
    }),
  );
}

async function createApp(name: string, options: { readonly grant?: string }) {
  let starts = 0;
  let completes = 0;
  const executions: string[] = [];
  const weatherAuth: AuthorizationDefinition<{ nonce: string }> = {
    principalType: "user",
    ...(options.grant !== undefined && { vercelConnect: { connector: options.grant } }),
    async getToken(): Promise<TokenResult> {
      throw new ConnectionAuthorizationRequiredError("weather");
    },
    async startAuthorization({ callbackUrl }) {
      starts += 1;
      return {
        challenge: {
          displayName: "Weather",
          instructions: "Sign in to continue.",
          url: `https://idp.example/authorize?callback=${encodeURIComponent(callbackUrl)}`,
        },
        resume: { nonce: "weather-nonce" },
      };
    },
    async completeAuthorization(): Promise<TokenResult> {
      completes += 1;
      return { token: "weather-token" };
    },
  };
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model: scriptedModel(), modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Get the weather for a city.",
            async execute(input, ctx) {
              const token = await ctx.getToken(weatherAuth, {
                authKey: "weather",
                displayName: "Weather",
              });
              executions.push(input.city);
              return { city: input.city, summary: `authorized with ${token.token}` };
            },
            inputSchema: z.object({ city: z.string() }),
          }),
        }),
        logicalPath: "tools/get_weather.ts",
      },
    ],
  });
  return {
    completes: () => completes,
    executions: () => executions,
    name,
    runtime,
    starts: () => starts,
  };
}

async function startParent(name: string) {
  return await startSessionOwner(workflowEntry, [
    {
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      input: { message: "Ask three helpers for the weather in Lisbon." },
      serializedContext: {
        ...buildSerializedContext({
          auth: ALICE,
          channelKind: "http",
          continuationToken: `http:${name}`,
        }),
        "eve.capabilities": { requestInput: true },
      },
    },
  ]);
}

/** Waits until the parent has taken in `count` relayed requests from its children. */
async function waitForRelays(runId: string, count: number): Promise<void> {
  const world = await getWorld();
  await vi.waitFor(
    async () => {
      const steps = await world.steps.list({ runId, resolveData: "none" });
      const relays = steps.data.filter(
        (step) =>
          step.stepName.endsWith("//runProxySubagentEventStep") && step.status === "completed",
      );
      expect(relays.length).toBeGreaterThanOrEqual(count);
    },
    { interval: 100, timeout: 30_000 },
  );
}

/** Everything the session has written so far. */
async function history(sessionId: string): Promise<SessionStreamEvent[]> {
  const events: SessionStreamEvent[] = [];
  const read = readSessionEventHistory(sessionId).getReader();
  for (let next = await read.read(); !next.done; next = await read.read()) events.push(next.value);
  return events;
}

/** Calls the callback URL a sign-in card names, as the provider redirects back to it. */
async function completeSignIn(
  card: SessionStreamEvent,
  params: Readonly<Record<string, string>>,
): Promise<void> {
  if (card.type !== "interaction.opened") throw new Error("Expected a sign-in card.");
  const callbackUrl = card.data.request.signIn?.callbackUrl;
  if (callbackUrl === undefined) throw new Error("Expected the sign-in to name its callback.");
  const callback = parseEveConnectionCallbackRoutePath(new URL(callbackUrl).pathname);
  if (callback === undefined) throw new Error(`Expected a callback route: ${callbackUrl}`);
  await resumeAuthorizationCallback(callback.token, {
    kind: "authorization-callback",
    payloads: [
      {
        authorizationCallback: {
          attemptId: callback.attemptId,
          callback: { method: "GET", params },
          connectionName: callback.name,
        },
      },
    ],
  });
}

function isSignInOpened(event: SessionStreamEvent): boolean {
  return event.type === "interaction.opened" && event.data.request.kind === "sign-in";
}

function isTurnSettled(event: SessionStreamEvent): boolean {
  return event.type === "turn.settled";
}

function signInId(event: SessionStreamEvent): string {
  if (event.type !== "interaction.opened") throw new Error("Expected a sign-in card.");
  return event.data.interactionId;
}
