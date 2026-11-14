// @linux-only: sign-in flow
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
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
const FIRST = "Summarize today's issues.";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a dynamic model that needs a sign-in", () => {
  it("asks before the first model call and answers in the same turn after sign-in", async () => {
    const billing = billingProvider();
    await withSession(billing, async (session) => {
      const asked = await session.asked();
      expect(opened(asked)?.data.subject).toHaveProperty("turnId");
      expect(opened(asked)?.data.request.signIn?.displayName).toBe("Billing");
      expect(filterEventsByType(asked, "model.requested")).toHaveLength(0);

      const answered = await session.callBack();
      expect(cardOutcome(answered, asked)).toBe("accepted");
      expect(filterEventsByType(answered, "turn.started")).toHaveLength(0);
      expect(turnSettled(answered)).toMatchObject({ outcome: "completed" });
      expect(billing.tokensSeen).toEqual(["billing-token-1"]);
      expect(userMessages(billing.prompts.at(-1))).toEqual([FIRST]);
    });
  });

  it("ends a model call that calls requireAuth, and runs it again after sign-in", async () => {
    const billing = billingProvider({ token: "revoked-token" });
    await withSession(billing, async (session) => {
      const asked = await session.asked();
      expect(filterEventsByType(asked, "model.settled")).toMatchObject([
        { data: { outcome: "abandoned" } },
      ]);
      expect(turnSettled(await session.callBack())).toMatchObject({ outcome: "completed" });
      expect(billing.tokensSeen).toEqual(["revoked-token", "billing-token-1"]);
    });
  });

  it("asks when a compaction summary calls requireAuth, and answers after sign-in", async () => {
    const billing = billingProvider({ token: "revoked-token" });
    await withSession(
      billing,
      async (session) => {
        await session.stream.nextUntil("first answer", isTurnSettled);
        await session.send("And yesterday's?");
        await session.asked();
        expect(turnSettled(await session.callBack())).toMatchObject({ outcome: "completed" });
        expect(billing.summaryTokens).toEqual(["revoked-token", "billing-token-1"]);
      },
      { bigFirstAnswer: true },
    );
  });

  it("fails a scheduled turn without asking", async () => {
    const billing = billingProvider();
    await withSession(
      billing,
      async (session) => {
        const events = await session.stream.nextUntil("scheduled turn", isTurnSettled);
        expect(events.filter(isSignInOpened)).toEqual([]);
        expect(billing.starts()).toBe(0);
        expect(turnSettled(events)).toMatchObject(
          signInFailed("The sign-in to Billing didn't finish."),
        );
      },
      { scheduled: true },
    );
  });

  it.each([
    ["in the process that completed the sign-in", false],
    ["in a fresh process", true],
  ])(
    "fails the turn when the provider rejects the token from sign-in, %s",
    async (_where, cold) => {
      if (cold) vi.stubEnv("EVE_DEFINITIONS_COLD", "1");
      const billing = billingProvider({ token: "revoked-token" });
      await withSession(
        billing,
        async (session) => {
          await session.asked();
          const settled = await session.callBack();
          expect(settled.filter(isSignInOpened)).toEqual([]);
          expect(billing.starts()).toBe(1);
          expect(turnSettled(settled)).toMatchObject(
            signInFailed("The sign-in to Billing didn't finish."),
          );
        },
        { rejectEveryToken: true },
      );
    },
  );
});

describe("a model sign-in that doesn't complete", () => {
  it("fails the turn and settles the card declined when the person declines", async () => {
    await withSession(billingProvider(), async (session) => {
      const asked = await session.asked();
      const settled = await session.callBack({ error: "access_denied" });
      expect(cardOutcome(settled, asked)).toBe("declined");
      expect(filterEventsByType(settled, "model.requested")).toHaveLength(0);
      expect(turnSettled(settled)).toMatchObject(
        signInFailed("The sign-in to Billing didn't finish."),
      );
    });
  });

  it("shows the provider's own failure message", async () => {
    const billing = billingProvider({ failCompletion: "Save your API key first." });
    await withSession(billing, async (session) => {
      const asked = await session.asked();
      const settled = await session.callBack();
      expect(cardOutcome(settled, asked)).toBe("failed");
      expect(turnSettled(settled)).toMatchObject(signInFailed("Billing: Save your API key first."));
    });
  });

  it("cancels the turn when the person cancels it during the sign-in", async () => {
    await withSession(billingProvider(), async (session) => {
      await session.asked();
      await resumeRoutedHook(sessionInboxHookToken(sessionCommandHookToken(session.run.runId)), {
        auth: alice,
        deliveryId: "alice-cancel",
        kind: "cancel",
      });
      const settled = await session.stream.nextUntil("cancel", isTurnSettled);
      expect(filterEventsByType(settled, "model.requested")).toHaveLength(0);
      expect(turnSettled(settled)).toMatchObject({ outcome: "cancelled" });
    });
  });

  it("holds a new message behind the sign-in and keeps it when the person declines", async () => {
    const billing = billingProvider();
    await withSession(billing, async (session) => {
      await session.asked();
      await session.send("Only the open ones.");
      const held = await session.stream.nextUntil("held", (event) => event.type === "turn.paused");
      expect(held.filter(isSignInOpened)).toEqual([]);
      await session.callBack({ error: "access_denied" });

      await session.send("Try again.");
      await session.asked();
      expect(turnSettled(await session.callBack())).toMatchObject({ outcome: "completed" });
      expect(userMessages(billing.prompts.at(-1))).toEqual([
        FIRST,
        "Only the open ones.",
        "Try again.",
      ]);
    });
  });

  it("fails the turn without a card when a provider has no sign-in flow", async () => {
    const provider = {
      getToken: async (): Promise<TokenResult> => {
        throw new ConnectionAuthorizationRequiredError("docs");
      },
    };
    await withAgent(
      "model-sign-in-static",
      async (ctx) => {
        await ctx.getToken(provider, { displayName: "Docs API" });
        return plainModel();
      },
      async (session) => {
        const settled = await session.stream.nextUntil("refusal", isTurnSettled);
        expect(settled.filter(isSignInOpened)).toEqual([]);
        expect(turnSettled(settled)).toMatchObject(
          signInFailed("The sign-in to Docs API didn't finish."),
        );
      },
    );
  });
});

it("gives each dynamic value its own plain provider's token", async () => {
  const seen: Record<string, string> = {};
  const read = async (ctx: DynamicModelContext, name: string) => {
    seen[name] = (await ctx.getToken({ getToken: async () => ({ token: `${name}-key` }) })).token;
  };
  const instructions = (logicalPath: string, name: string) => ({
    logicalPath,
    loadNamespace: async () => ({
      default: defineDynamic(async (ctx: DynamicModelContext) => {
        await read(ctx, name);
        return defineInstructions({ content: `Answer from ${name}.` });
      }),
    }),
  });
  await withAgent(
    "plain-providers",
    async (ctx) => {
      await read(ctx, "model");
      return plainModel();
    },
    async (session) => {
      await session.stream.nextUntil("answer", isTurnSettled);
      expect(seen).toEqual({
        docs: "docs-key",
        "foo/bar": "foo/bar-key",
        foo_bar: "foo_bar-key",
        model: "model-key",
      });
    },
    [
      instructions("instructions/docs.ts", "docs"),
      instructions("instructions/foo/bar.ts", "foo/bar"),
      instructions("instructions/foo_bar.ts", "foo_bar"),
    ],
  );
});

interface SessionOptions {
  readonly bigFirstAnswer?: boolean;
  readonly rejectEveryToken?: boolean;
  readonly scheduled?: boolean;
}

let sessions = 0;

/** Runs `body` against a session of an agent whose dynamic model returns `model(ctx)`. */
async function withAgent(
  name: string,
  model: (ctx: DynamicModelContext) => Promise<ReturnType<typeof plainModel>>,
  body: (session: ReturnType<typeof openSession>) => Promise<void>,
  modules: NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"] = [],
  options: SessionOptions = {},
) {
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(async (ctx: DynamicModelContext) => ({
          model: await model(ctx),
          modelContextWindowTokens: 200_000,
        })),
      }),
      name,
    },
    modules,
  });
  await runtime.run(async () => {
    const continuationToken = `http:${name}`;
    const run = await startTestSession("in-process", {
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      input: { message: FIRST },
      serializedContext: options.scheduled
        ? {
            ...buildSerializedContext({
              auth: alice,
              channelKind: "schedule",
              continuationToken: `eve-scheduled-send:${name}`,
            }),
            "eve.scheduleId": "daily-summary",
          }
        : buildSerializedContext({ auth: alice, channelKind: "http", continuationToken }),
    });
    const session = openSession(run, continuationToken);
    try {
      await body(session);
    } finally {
      session.stream.dispose();
      await run.cancel();
    }
  });
}

/** A started session and its test steps: wait for the card, call it back, send a message. */
function openSession(run: Awaited<ReturnType<typeof startTestSession>>, continuationToken: string) {
  const stream = captureEvents(run);
  let latest: SessionStreamEvent[] = [];
  return {
    run,
    stream,
    /** Waits for the sign-in card and the paused turn; returns the events up to the card. */
    async asked() {
      latest = await stream.nextUntil("sign-in", isSignInOpened);
      await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");
      return latest;
    },
    /** Calls the latest card back, and returns the events until the turn settles. */
    async callBack(params: Readonly<Record<string, string>> = { code: "oauth-code" }) {
      const attemptId = opened(latest)!.data.interactionId;
      const callback = { method: "GET" as const, params };
      await resumeRoutedHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
        kind: "authorization-callback",
        payloads: [
          {
            authorizationCallback: {
              attemptId,
              callback,
              connectionName: "eve:dynamic__oauth_billing",
            },
          },
        ],
      });
      return await stream.nextUntil("settled turn", isTurnSettled);
    },
    async send(message: string) {
      await resumeRoutedHook(sessionInboxHookToken(continuationToken), {
        auth: alice,
        kind: "send",
        delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
        payload: { message },
      });
    },
  };
}

/** Runs `body` against an agent whose dynamic model reads `billing`'s token before every call. */
async function withSession(
  billing: BillingProvider,
  body: (session: ReturnType<typeof openSession>) => Promise<void>,
  options: SessionOptions = {},
) {
  sessions += 1;
  await withAgent(
    `model-sign-in-${String(sessions)}`,
    async (ctx) => billedModel(ctx, billing, (await ctx.getToken(billing.auth)).token, options),
    body,
    [],
    options,
  );
}

type BillingProvider = ReturnType<typeof billingProvider>;

/** A provider with one token per person. A sign-in replaces the token. */
function billingProvider(
  initial: { readonly token?: string; readonly failCompletion?: string } = {},
) {
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
        if (initial.failCompletion !== undefined)
          throw new ConnectionAuthorizationFailedError("billing", {
            message: initial.failCompletion,
            reason: "no_key_saved",
            retryable: false,
          });
        issued += 1;
        stored = `billing-token-${String(issued)}`;
        return { token: stored };
      },
    } satisfies AuthorizationDefinition<{ nonce: string }>,
    /** The billed model's prompts, oldest first. */
    prompts: [] as unknown[],
    starts: () => starts,
    summaryTokens: [] as string[],
    tokensSeen: [] as string[],
  };
}

function billedModel(
  ctx: DynamicModelContext,
  billing: BillingProvider,
  token: string,
  options: SessionOptions,
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
        billing.prompts.push(prompt);
        if (options.rejectEveryToken === true) ctx.requireAuth(billing.auth);
        if (options.bigFirstAnswer === true)
          return billing.tokensSeen.length === 1
            ? bigStreamResult("Here is the summary.")
            : textStreamResult("Here is the summary.");
        if (token === "revoked-token") ctx.requireAuth(billing.auth);
        return textStreamResult("Here is the summary.");
      },
      modelId: "billed-model",
      provider: "eve-test",
    }),
  );
}

function signInFailed(message: string) {
  return { error: { code: "SIGN_IN_FAILED", message }, outcome: "failed" };
}

function opened(events: readonly SessionStreamEvent[]) {
  return filterEventsByType(events, "interaction.opened").find(
    (event) => event.data.request.kind === "sign-in",
  );
}

function cardOutcome(events: readonly SessionStreamEvent[], asked: readonly SessionStreamEvent[]) {
  return filterEventsByType(events, "interaction.settled").find(
    (event) => event.data.interactionId === opened(asked)?.data.interactionId,
  )?.data.outcome;
}

function turnSettled(events: readonly SessionStreamEvent[]) {
  return filterEventsByType(events, "turn.settled").at(-1)?.data;
}

/** The text of each user message in a model prompt, in order. */
function userMessages(prompt: unknown): string[] {
  if (!Array.isArray(prompt)) return [];
  return prompt.flatMap((message: { role: string; content: unknown }) =>
    message.role !== "user" || !Array.isArray(message.content)
      ? []
      : message.content.flatMap((part: { type: string; text?: string }) =>
          part.type === "text" && part.text !== undefined ? [part.text] : [],
        ),
  );
}

function isSignInOpened(event: SessionStreamEvent): boolean {
  return event.type === "interaction.opened" && event.data.request.kind === "sign-in";
}

function isTurnSettled(event: SessionStreamEvent): boolean {
  return event.type === "turn.settled";
}

/** A reply whose usage fills the context window, so the next step compacts first. */
function bigStreamResult(text: string): ReturnType<typeof textStreamResult> {
  const inputTokens = {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 200_000,
    total: 200_000,
  };
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
          usage: { ...usage, inputTokens },
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
