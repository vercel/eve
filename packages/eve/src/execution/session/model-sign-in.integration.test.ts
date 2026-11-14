// @linux-only: sign-in flow
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { defineDynamic, type DynamicModelContext } from "#dynamic/definition.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, usage } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { startTestSession } from "#internal/testing/test-session-hosts.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import type { AuthorizationDefinition, TokenResult } from "#shared/connection-types.js";

const alice = {
  attributes: {},
  authenticator: "test-idp",
  issuer: "test-idp",
  principalId: "user-1",
  principalType: "user" as const,
};

describe("a dynamic model that needs a sign-in", () => {
  it("asks before the first model call and answers in the same turn once the person signs in", async () => {
    const billing = billingProvider();
    const runtime = await billingRuntime("model-sign-in", billing);

    await runtime.run(async () => {
      const run = await startBillingRun("http:model-sign-in");
      const stream = captureEvents(run);
      try {
        const asked = await stream.nextUntil("sign-in", isSignInOpened);
        const paused = await stream.nextUntil(
          "sign-in hold",
          (event) => event.type === "turn.paused",
        );
        const opened = filterEventsByType(asked, "interaction.opened").find(
          (event) => event.data.request.kind === "sign-in",
        );
        expect(opened?.data.subject).toHaveProperty("turnId");
        expect(opened?.data.request.signIn?.displayName).toBe("Billing");
        expect(filterEventsByType([...asked, ...paused], "model.requested")).toHaveLength(0);

        await resumeRoutedHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [billingCallback(signInId(asked))],
        });
        const answered = await stream.nextUntil("answer", isTurnSettled);

        expect(
          filterEventsByType(answered, "interaction.settled").filter(
            (event) => event.data.interactionId === signInId(asked),
          ),
        ).toMatchObject([{ data: { outcome: "accepted" } }]);
        expect(filterEventsByType(answered, "turn.started")).toHaveLength(0);
        expect(filterEventsByType(answered, "turn.settled")).toMatchObject([
          { data: { outcome: "completed" } },
        ]);
        expect(billing.tokensSeen).toEqual(["billing-token-1"]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("ends the model call when the model code calls requireAuth, and runs it again after sign-in", async () => {
    const billing = billingProvider({ token: "revoked-token" });
    const runtime = await billingRuntime("model-sign-in-rejected", billing);

    await runtime.run(async () => {
      const run = await startBillingRun("http:model-sign-in-rejected");
      const stream = captureEvents(run);
      try {
        const asked = await stream.nextUntil("sign-in", isSignInOpened);
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");
        expect(filterEventsByType(asked, "model.settled")).toMatchObject([
          { data: { outcome: "abandoned" } },
        ]);

        await resumeRoutedHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [billingCallback(signInId(asked))],
        });
        const answered = await stream.nextUntil("answer", isTurnSettled);
        expect(filterEventsByType(answered, "turn.settled")).toMatchObject([
          { data: { outcome: "completed" } },
        ]);
        expect(billing.tokensSeen).toEqual(["revoked-token", "billing-token-1"]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("fails a scheduled turn without asking", async () => {
    const billing = billingProvider();
    const runtime = await billingRuntime("model-sign-in-scheduled", billing);

    await runtime.run(async () => {
      const run = await startTestSession("in-process", {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Summarize today's issues." },
        serializedContext: {
          ...buildSerializedContext({
            auth: alice,
            channelKind: "schedule",
            continuationToken: "eve-scheduled-send:model-sign-in",
          }),
          "eve.scheduleId": "daily-summary",
        },
      });
      const stream = captureEvents(run);
      try {
        const events = await stream.nextUntil("scheduled turn", isTurnSettled);
        expect(events.filter(isSignInOpened)).toEqual([]);
        expect(billing.starts()).toBe(0);
        expect(filterEventsByType(events, "model.requested")).toHaveLength(0);
        expect(JSON.stringify(filterEventsByType(events, "turn.settled"))).toContain(
          "isn't asked for in a scheduled run",
        );
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("asks again when a compaction summary calls requireAuth, and answers after sign-in", async () => {
    const billing = billingProvider({ token: "revoked-token" });
    const runtime = await billingRuntime("model-sign-in-compaction", billing, {
      bigFirstAnswer: true,
    });

    await runtime.run(async () => {
      const continuationToken = "http:model-sign-in-compaction";
      const run = await startBillingRun(continuationToken);
      const stream = captureEvents(run);
      try {
        await stream.nextUntil("first answer", isTurnSettled);
        await resumeRoutedHook(sessionInboxHookToken(continuationToken), {
          auth: alice,
          kind: "send",
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          payload: { message: "And yesterday's?" },
        });
        const asked = await stream.nextUntil("sign-in", isSignInOpened);
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");
        expect(filterEventsByType(asked, "turn.settled")).toHaveLength(0);

        await resumeRoutedHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [billingCallback(signInId(asked))],
        });
        const answered = await stream.nextUntil("answer", isTurnSettled);
        expect(filterEventsByType(answered, "turn.settled")).toMatchObject([
          { data: { outcome: "completed" } },
        ]);
        expect(billing.summaryTokens).toEqual(["revoked-token", "billing-token-1"]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});

describe("a provider that rejects the token from sign-in", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["in the process that completed the sign-in", false],
    ["in a fresh process", true],
  ])("fails the turn without asking again, %s", async (_where, cold) => {
    // Every step starts without built code, as a fresh process does.
    if (cold) vi.stubEnv("EVE_DEFINITIONS_COLD", "1");
    const billing = billingProvider({ token: "revoked-token" });
    const runtime = await billingRuntime(`model-sign-in-refused-${cold}`, billing, {
      rejectEveryToken: true,
    });

    await runtime.run(async () => {
      const run = await startBillingRun(`http:model-sign-in-refused-${cold}`);
      const stream = captureEvents(run);
      try {
        const asked = await stream.nextUntil("sign-in", isSignInOpened);
        await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");

        await resumeRoutedHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          kind: "authorization-callback",
          payloads: [billingCallback(signInId(asked))],
        });
        const settled = await stream.nextUntil("refusal", isTurnSettled);
        expect(settled.filter(isSignInOpened)).toEqual([]);
        expect(billing.starts()).toBe(1);
        expect(filterEventsByType(settled, "turn.settled")).toMatchObject([
          { data: { outcome: "failed" } },
        ]);
        expect(JSON.stringify(filterEventsByType(settled, "turn.settled"))).toContain(
          "rejected the token immediately after authorization",
        );
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});

describe("dynamic values with plain providers", () => {
  it("gives each value its own provider's token", async () => {
    const seen: Record<string, string> = {};
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(async (ctx: DynamicModelContext) => {
            seen.model = (
              await ctx.getToken({ getToken: async () => ({ token: "model-key" }) })
            ).token;
            return { model: plainModel(), modelContextWindowTokens: 200_000 };
          }),
        }),
        name: "plain-providers",
      },
      modules: [
        plainInstructions("instructions/docs.ts", "docs", seen),
        plainInstructions("instructions/foo/bar.ts", "foo/bar", seen),
        plainInstructions("instructions/foo_bar.ts", "foo_bar", seen),
      ],
    });

    await runtime.run(async () => {
      const run = await startBillingRun("http:plain-providers");
      const stream = captureEvents(run);
      try {
        await stream.nextUntil("answer", isTurnSettled);
        expect(seen).toEqual({
          docs: "docs-key",
          "foo/bar": "foo/bar-key",
          foo_bar: "foo_bar-key",
          model: "model-key",
        });
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});

/** Dynamic instructions at `logicalPath` that read a plain provider's token into `seen[name]`. */
function plainInstructions(logicalPath: string, name: string, seen: Record<string, string>) {
  return {
    logicalPath,
    loadNamespace: async () => ({
      default: defineDynamic(async (ctx: DynamicModelContext) => {
        seen[name] = (
          await ctx.getToken({ getToken: async () => ({ token: `${name}-key` }) })
        ).token;
        return defineInstructions({ content: `Answer from ${name}.` });
      }),
    }),
  };
}

interface BillingProvider {
  readonly auth: AuthorizationDefinition<{ nonce: string }>;
  readonly starts: () => number;
  readonly summaryTokens: string[];
  readonly tokensSeen: string[];
}

/** A provider with one token per person. A sign-in replaces the token. */
function billingProvider(initial: { readonly token?: string } = {}): BillingProvider {
  let stored = initial.token;
  let issued = 0;
  let starts = 0;
  return {
    auth: {
      principalType: "user",
      vercelConnect: { connector: "oauth/billing" },
      async getToken(): Promise<TokenResult> {
        if (stored === undefined) throw new ConnectionAuthorizationRequiredError("billing");
        return { token: stored };
      },
      async evict() {
        stored = undefined;
      },
      async startAuthorization({ callbackUrl }) {
        starts += 1;
        return {
          challenge: {
            displayName: "Billing",
            url: `https://idp.example/authorize?cb=${callbackUrl}`,
          },
          resume: { nonce: "billing-nonce" },
        };
      },
      async completeAuthorization(): Promise<TokenResult> {
        issued += 1;
        stored = `billing-token-${issued}`;
        return { token: stored };
      },
    },
    starts: () => starts,
    summaryTokens: [],
    tokensSeen: [],
  };
}

/** This agent's model reads the caller's token before every call. */
async function billingRuntime(
  name: string,
  billing: BillingProvider,
  options: BilledModelOptions = {},
) {
  return await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(async (ctx: DynamicModelContext) => {
          const { token } = await ctx.getToken(billing.auth);
          return {
            model: billedModel(ctx, billing, token, options),
            modelContextWindowTokens: 200_000,
          };
        }),
      }),
      name,
    },
  });
}

interface BilledModelOptions {
  readonly bigFirstAnswer?: boolean;
  readonly rejectEveryToken?: boolean;
}

function billedModel(
  ctx: DynamicModelContext,
  billing: BillingProvider,
  token: string,
  options: BilledModelOptions,
) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        if (JSON.stringify(prompt).includes("previous checkpoint")) {
          billing.summaryTokens.push(token);
          if (token === "revoked-token") ctx.requireAuth(billing.auth);
          return textStreamResult("Checkpoint: Alice asked for today's issues.");
        }
        billing.tokensSeen.push(token);
        if (options.rejectEveryToken === true) ctx.requireAuth(billing.auth);
        if (options.bigFirstAnswer === true && billing.tokensSeen.length === 1) {
          return bigStreamResult("Here is the summary.");
        }
        if (token === "revoked-token" && options.bigFirstAnswer !== true) {
          ctx.requireAuth(billing.auth);
        }
        return textStreamResult("Here is the summary.");
      },
      modelId: "billed-model",
      provider: "eve-test",
    }),
  );
}

async function startBillingRun(continuationToken: string) {
  return await startTestSession("in-process", {
    kind: "initial",
    ownerDeploymentId: "dpl_inline",
    input: { message: "Summarize today's issues." },
    serializedContext: buildSerializedContext({
      auth: alice,
      channelKind: "http",
      continuationToken,
    }),
  });
}

function billingCallback(attemptId: string) {
  return {
    authorizationCallback: {
      attemptId,
      callback: { method: "GET", params: { code: "oauth-code" } },
      connectionName: "agent__oauth_billing",
    },
  };
}

function isSignInOpened(event: SessionStreamEvent): boolean {
  return event.type === "interaction.opened" && event.data.request.kind === "sign-in";
}

function isTurnSettled(event: SessionStreamEvent): boolean {
  return event.type === "turn.settled";
}

function signInId(events: readonly SessionStreamEvent[]): string {
  const opened = filterEventsByType(events, "interaction.opened").find(
    (event) => event.data.request.kind === "sign-in",
  );
  if (opened === undefined) throw new Error("Expected a sign-in interaction.");
  return opened.data.interactionId;
}

/** A reply whose usage fills the context window, so the next step compacts first. */
function bigStreamResult(text: string): ReturnType<typeof textStreamResult> {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { id: "answer", type: "text-start" },
        { delta: text, id: "answer", type: "text-delta" },
        { id: "answer", type: "text-end" },
        {
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage: {
            ...usage,
            inputTokens: {
              cacheRead: undefined,
              cacheWrite: undefined,
              noCache: 200_000,
              total: 200_000,
            },
          },
        },
      ],
    }),
  };
}

function plainModel() {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async () => textStreamResult("Here is the answer."),
      modelId: "plain-model",
      provider: "eve-test",
    }),
  );
}
