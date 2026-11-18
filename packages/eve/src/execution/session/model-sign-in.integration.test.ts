import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  textStreamResult,
  toolCallStreamResult,
  usage,
} from "#internal/testing/approval-resume.js";
import { mockTool } from "#internal/testing/mocks/mock-tool.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { startTestSession } from "#internal/testing/test-session-hosts.js";
import { defineModel, type ModelDefinition } from "#models/definition.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { interactions } from "#protocol/session-projection/public-view.js";
import { defineAgent, type AgentDefinition } from "#public/definitions/agent.js";
import type { AuthorizationDefinition, TokenResult } from "#shared/connection-types.js";

const alice = {
  attributes: {},
  authenticator: "test-idp",
  issuer: "test-idp",
  principalId: "user-1",
  principalType: "user" as const,
};
const FIRST = "Summarize today's issues.";
const BILLING_SIGN_IN = "eve__model__oauth_billing";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("replaces a model definition with eve's mock model before auth or create runs", async () => {
  vi.stubEnv("NODE_ENV", "test");
  const getToken = vi.fn(async (): Promise<TokenResult> => ({ token: "billing-token" }));
  const create = vi.fn(() => plainModel());
  const billing = defineModel({
    auth: { getToken },
    authKey: "billing",
    create,
    id: "billing/claude",
  });
  await withAgent(
    "model-sign-in-mocked",
    defineAgent({ model: billing, modelContextWindowTokens: 200_000 }),
    async (session) => {
      const settled = await session.stream.nextUntil("answer", isTurnSettled);
      expect(turnSettled(settled)).toMatchObject({ outcome: "completed" });
      expect(getToken).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );
});

describe("a model that needs the caller's credential", () => {
  it("asks before the first model call and answers in the same turn after sign-in", async () => {
    const billing = billingProvider();
    await withSession(billing, async (session) => {
      const asked = await session.asked();
      expect(opened(asked)?.data.subject).toHaveProperty("turnId");
      expect(opened(asked)?.data.request.signIn).toMatchObject({
        displayName: "Billing",
        grant: "oauth/billing",
        name: BILLING_SIGN_IN,
      });
      expect(filterEventsByType(asked, "model.requested")).toHaveLength(0);

      const answered = await session.callBack();
      expect(cardOutcome(answered, asked)).toBe("accepted");
      expect(filterEventsByType(answered, "turn.started")).toHaveLength(0);
      expect(turnSettled(answered)).toMatchObject({ outcome: "completed" });
      expect(billing.tokensSeen).toEqual(["billing-token-1"]);
      expect(billing.evictions).toBe(0);
      expect(userMessages(billing.prompts.at(-1))).toEqual([FIRST]);
    });
  });

  it("asks for a static model too", async () => {
    const billing = billingProvider();
    await withAgent(
      "model-sign-in-static",
      defineAgent({ model: billing.model, modelContextWindowTokens: 200_000 }),
      async (session) => {
        await session.asked();
        expect(turnSettled(await session.callBack())).toMatchObject({ outcome: "completed" });
        expect(billing.tokensSeen).toEqual(["billing-token-1"]);
      },
    );
  });

  it("retries a rejected token once with a fresh one, without asking", async () => {
    const billing = billingProvider({ refresh: "fresh-token", token: "stale-token" });
    await withSession(billing, async (session) => {
      const settled = await session.stream.nextUntil("answer", isTurnSettled);
      expect(settled.filter(isSignInOpened)).toEqual([]);
      expect(turnSettled(settled)).toMatchObject({ outcome: "completed" });
      expect(billing.tokensSeen).toEqual(["stale-token", "fresh-token"]);
      expect(billing.evictions).toBe(1);
    });
  });

  it("asks again when the provider rejects the retried token, and answers after sign-in", async () => {
    const billing = billingProvider({ refresh: "stale-token", token: "stale-token" });
    await withSession(billing, async (session) => {
      const asked = await session.asked();
      expect(filterEventsByType(asked, "model.settled")).toMatchObject([
        { data: { outcome: "abandoned" } },
      ]);
      expect(turnSettled(await session.callBack())).toMatchObject({ outcome: "completed" });
      expect(billing.tokensSeen).toEqual(["stale-token", "stale-token", "billing-token-1"]);
      expect(billing.evictions).toBe(2);
    });
  });

  it("asks when a compaction summary's token is rejected, and answers after sign-in", async () => {
    const billing = billingProvider({ refresh: "stale-token", token: "stale-token" });
    await withSession(
      billing,
      async (session) => {
        await session.stream.nextUntil("first answer", isTurnSettled);
        await session.send("And yesterday's?");
        await session.asked();
        expect(turnSettled(await session.callBack())).toMatchObject({ outcome: "completed" });
        expect(billing.summaryTokens).toEqual(["stale-token", "stale-token", "billing-token-1"]);
      },
      { bigFirstAnswer: true, rejectStaleOnlyInSummary: true },
    );
  });

  describe("after the process drops the dynamic model's value", () => {
    const dropLiveValues = () =>
      (Reflect.get(globalThis, Symbol.for("eve.reactions.live")) as Map<string, unknown>).clear();

    it("fails the turn on the sign-in callback when the dynamic model throws", async () => {
      const billing = billingProvider();
      let throws = false;
      await withAgent(
        "model-sign-in-dropped-at-callback",
        defineAgent({
          model: defineDynamic(() => {
            if (throws) throw new Error("Selection service down.");
            return { model: billing.model, modelContextWindowTokens: 200_000 };
          }),
        }),
        async (session) => {
          await session.asked();
          throws = true;
          dropLiveValues();
          const answered = await session.callBack();
          expect(turnSettled(answered)).toMatchObject({
            error: { code: "REACTION_FAILED", message: "Selection service down." },
            outcome: "failed",
          });
          expect(filterEventsByType(answered, "session.ended")).toEqual([]);
          expect(billing.tokensSeen).toEqual([]);
        },
      );
    });

    it("fails the turn before the next model step when the dynamic model throws", async () => {
      let throws = false;
      const tokens: string[] = [];
      const own = defineModel({
        auth: { getToken: async () => ({ token: "alice-token" }) },
        authKey: "own",
        create: ({ token }) =>
          markMockModel(
            new MockLanguageModelV4({
              doStream: async () => {
                tokens.push(token);
                return toolCallStreamResult({ input: "{}", toolCallId: "c1", toolName: "lookup" });
              },
            }),
          ),
        id: "own/model",
      });
      const lookup = mockTool({
        name: "lookup",
        execute() {
          throws = true;
          dropLiveValues();
          return { found: true };
        },
      });
      await withAgent(
        "model-sign-in-dropped-between-steps",
        defineAgent({
          model: defineDynamic(() => {
            if (throws) throw new Error("Selection service down.");
            return { model: own, modelContextWindowTokens: 200_000 };
          }),
        }),
        async (session) => {
          const settled = await session.stream.nextUntil("failed turn", isTurnSettled);
          expect(turnSettled(settled)).toMatchObject({
            error: { code: "REACTION_FAILED", message: "Selection service down." },
            outcome: "failed",
          });
          expect(filterEventsByType(settled, "session.ended")).toEqual([]);
          expect(tokens).toEqual(["alice-token"]);
        },
        { tools: [lookup] },
      );
    });
  });

  it.each(["has no credential", "fails to build"] as const)(
    "compacts with compaction.model when the turn model %s",
    async (breakage) => {
      let broken = false;
      const summaries: number[] = [];
      const turnModel = defineModel({
        auth: {
          getToken: async () => {
            if (broken && breakage === "has no credential")
              throw new ConnectionAuthorizationRequiredError("own");
            return { token: "alice-token" };
          },
        },
        authKey: "own",
        create: () => {
          if (broken && breakage === "fails to build") throw new Error("Missing billing region.");
          return plainModel();
        },
        id: "own/model",
      });
      const summaryModel = markMockModel(
        new MockLanguageModelV4({
          doStream: async () => {
            summaries.push(1);
            return textStreamResult("Checkpoint: Alice asked for today's issues.");
          },
        }),
      );
      await withAgent(
        `model-sign-in-compaction-${breakage.replaceAll(" ", "-")}`,
        defineAgent({
          compaction: { model: summaryModel, modelContextWindowTokens: 200_000 },
          model: turnModel,
          modelContextWindowTokens: 200_000,
        }),
        async (session) => {
          await session.stream.nextUntil("first turn", isTurnSettled);
          broken = true;
          await session.compact();
          const compacted = await session.stream.nextUntil(
            "compaction",
            (event) =>
              event.type === "delivery.settled" && event.data.deliveryId === "control_compact",
          );
          expect(filterEventsByType(compacted, "delivery.settled").at(-1)?.data).toMatchObject({
            outcome: "applied",
          });
          expect(summaries).toEqual([1]);
        },
      );
    },
  );

  it("answers with the new selection when it changes before the callback", async () => {
    const billing = billingProvider();
    let switched = false;
    await withAgent(
      "model-sign-in-switched",
      defineAgent({
        model: defineDynamic(() => ({
          model: switched ? plainModel() : billing.model,
          modelContextWindowTokens: 200_000,
        })),
      }),
      async (session) => {
        const asked = await session.asked();
        switched = true;
        const answered = await session.callBack();
        expect(turnSettled(answered)).toMatchObject({ outcome: "completed" });
        expect(cardOutcome(answered, asked)).toBe("interrupted");
        expect(billing.tokensSeen).toEqual([]);
      },
    );
  });

  it.each([
    [
      "auth fails before the model call",
      { outage: "getToken" },
      "MODEL_CREDENTIAL_FAILED",
      "eve couldn't get the Oauth billing credential.",
    ],
    [
      "auth fails while it opens the sign-in",
      { outage: "start" },
      "MODEL_CREDENTIAL_FAILED",
      "eve couldn't get the Oauth billing credential.",
    ],
    [
      "auth fails while it replaces a rejected token",
      { outage: "refresh", token: "stale-token" },
      "MODEL_CREDENTIAL_FAILED",
      "eve couldn't get the Oauth billing credential.",
    ],
    [
      "create throws",
      { outage: "create", token: "billing-token" },
      "MODEL_CREATE_FAILED",
      "eve couldn't build the model from the Oauth billing credential.",
    ],
    [
      "create returns no model",
      { outage: "create-output", token: "billing-token" },
      "MODEL_CREATE_FAILED",
      "eve couldn't build the model from the Oauth billing credential.",
    ],
    [
      "create returns a promise",
      { outage: "create-async", token: "billing-token" },
      "MODEL_CREATE_FAILED",
      "eve couldn't build the model from the Oauth billing credential.",
    ],
  ] as const)(
    "%s: fails the turn with its own code and keeps the session",
    async (_case, initial, code, message) => {
      const billing = billingProvider(initial);
      await withSession(billing, async (session) => {
        const settled = await session.stream.nextUntil("failed turn", isTurnSettled);
        expect(settled.filter(isSignInOpened)).toEqual([]);
        expect(filterEventsByType(settled, "session.ended")).toEqual([]);
        expect(billing.evictions).toBeLessThanOrEqual(1);
        expect(
          filterEventsByType(settled, "model.settled").map((event) => event.data.outcome),
        ).not.toContain("abandoned");
        expect(turnSettled(settled)).toMatchObject({ error: { code, message }, outcome: "failed" });
      });
    },
  );

  it("fails a scheduled turn without asking", async () => {
    const billing = billingProvider();
    await withSession(
      billing,
      async (session) => {
        const events = await session.stream.nextUntil("scheduled turn", isTurnSettled);
        expect(events.filter(isSignInOpened)).toEqual([]);
        expect(billing.starts()).toBe(0);
        expect(turnSettled(events)).toMatchObject(
          authorizationFailed("A scheduled turn can't ask for the Oauth billing sign-in."),
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
      const billing = billingProvider({ rejectEveryToken: true });
      await withSession(billing, async (session) => {
        await session.asked();
        const settled = await session.callBack();
        expect(settled.filter(isSignInOpened)).toEqual([]);
        expect(billing.starts()).toBe(1);
        expect(
          filterEventsByType(settled, "model.settled").map((event) => event.data.outcome),
        ).toEqual(["failed"]);
        expect(turnSettled(settled)).toMatchObject(
          authorizationFailed("Billing rejected the credential from the sign-in."),
        );
      });
    },
  );
});

describe("a model sign-in that ends without a credential", () => {
  it("settles the card declined, fails the turn, and asks again on the next turn", async () => {
    const billing = billingProvider();
    await withSession(billing, async (session) => {
      const asked = await session.asked();
      const settled = await session.callBack({ error: "access_denied" });
      expect(cardOutcome(settled, asked)).toBe("declined");
      expect(filterEventsByType(settled, "model.requested")).toHaveLength(0);
      expect(turnSettled(settled)).toMatchObject(
        authorizationFailed("The Billing sign-in ended without a credential."),
      );

      await session.send("Try again.");
      await session.asked();
      expect(turnSettled(await session.callBack())).toMatchObject({ outcome: "completed" });
      expect(userMessages(billing.prompts.at(-1))).toEqual([FIRST, "Try again."]);
    });
  });

  it("settles a declined callback declined and lets the dynamic model answer with another model", async () => {
    const billing = billingProvider();
    await withAgent(
      "model-sign-in-fallback",
      defineAgent({
        model: defineDynamic((ctx: DynamicModelContext) => ({
          model: refusedIn(ctx) ? plainModel() : billing.model,
          modelContextWindowTokens: 200_000,
        })),
      }),
      async (session) => {
        const asked = await session.asked();
        const settled = await session.callBack({ error: "access_denied" });
        expect(cardOutcome(settled, asked)).toBe("declined");
        expect(turnSettled(settled)).toMatchObject({ outcome: "completed" });
        expect(billing.tokensSeen).toEqual([]);
      },
    );
  });

  it("steers when a message arrives while the sign-in starts", async () => {
    const billing = billingProvider({ refresh: "stale-token", token: "stale-token" });
    await withAgent(
      "model-sign-in-steered-start",
      defineAgent({
        model: defineDynamic((ctx: DynamicModelContext) => ({
          model: refusedIn(ctx) ? plainModel() : billing.model,
          modelContextWindowTokens: 200_000,
        })),
      }),
      async (session) => {
        billing.onStart = async () => {
          billing.onStart = undefined;
          await session.send("Only the open ones.");
        };
        const settled = await session.stream.nextUntil("steered answer", isTurnSettled);
        expect(
          filterEventsByType(settled, "interaction.settled").map((e) => e.data.outcome),
        ).toEqual(["withdrawn"]);
        expect(turnSettled(settled)).toMatchObject({ outcome: "completed" });
        expect(billing.starts()).toBe(1);
        expect(billing.tokensSeen).toEqual(["stale-token", "stale-token"]);
      },
    );
  });

  it("shows the provider's own failure message", async () => {
    const billing = billingProvider({ failCompletion: "Save your API key first." });
    await withSession(billing, async (session) => {
      const asked = await session.asked();
      const settled = await session.callBack();
      expect(cardOutcome(settled, asked)).toBe("failed");
      expect(turnSettled(settled)).toMatchObject(
        authorizationFailed("Billing: Save your API key first."),
      );
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

  it("withdraws the sign-in when a message arrives, and fails the turn without a fallback", async () => {
    const billing = billingProvider();
    await withSession(billing, async (session) => {
      const asked = await session.asked();
      await session.send("Only the open ones.");
      const settled = await session.stream.nextUntil("withdrawn", isTurnSettled);
      expect(cardOutcome(settled, asked)).toBe("withdrawn");
      expect(turnSettled(settled)).toMatchObject(
        authorizationFailed("The Billing sign-in ended without a credential."),
      );

      await session.send("Try again.");
      await session.asked();
      expect(turnSettled(await session.callBack())).toMatchObject({ outcome: "completed" });
      expect(userMessages(billing.prompts.at(-1))).toEqual([
        FIRST,
        expect.stringContaining("Sign-in to Billing was cancelled"),
        "Only the open ones.",
        "Try again.",
      ]);
    });
  });

  it.each([
    [
      "has none",
      "model-sign-in-no-flow",
      () => Promise.reject(new ConnectionAuthorizationRequiredError("docs")),
      "The turn got no Docs API credential.",
    ],
    [
      "sees the provider reject it twice",
      "model-sign-in-no-flow-rejected",
      () => Promise.resolve({ token: "docs-token" }),
      "Docs API rejected the credential.",
    ],
  ])(
    "fails the turn without a card when a credential without a sign-in flow %s",
    async (_case, agentName, getToken: () => Promise<TokenResult>, message) => {
      const docs = defineModel({
        auth: { displayName: "Docs API", getToken },
        authKey: "docs",
        create: () => rejectingModel(),
        id: "docs/reader",
      });
      await withAgent(
        agentName,
        defineAgent({ model: docs, modelContextWindowTokens: 200_000 }),
        async (session) => {
          const settled = await session.stream.nextUntil("refusal", isTurnSettled);
          expect(settled.filter(isSignInOpened)).toEqual([]);
          expect(turnSettled(settled)).toMatchObject(authorizationFailed(message));
        },
      );
    },
  );
});

interface SessionOptions {
  readonly bigFirstAnswer?: boolean;
  readonly tools?: readonly ReturnType<typeof mockTool>[];
  readonly rejectStaleOnlyInSummary?: boolean;
  readonly scheduled?: boolean;
}

let sessions = 0;

async function withAgent(
  name: string,
  definition: AgentDefinition,
  body: (session: ReturnType<typeof openSession>) => Promise<void>,
  options: SessionOptions = {},
) {
  const runtime = await createTestRuntime({ agent: { definition, name }, tools: options.tools });
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

function openSession(run: Awaited<ReturnType<typeof startTestSession>>, continuationToken: string) {
  const stream = captureEvents(run);
  let latest: SessionStreamEvent[] = [];
  return {
    run,
    stream,
    async asked() {
      latest = await stream.nextUntil("sign-in", isSignInOpened);
      await stream.nextUntil("sign-in hold", (event) => event.type === "turn.paused");
      return latest;
    },
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
              connectionName: BILLING_SIGN_IN,
            },
          },
        ],
      });
      return await stream.nextUntil("settled turn", isTurnSettled);
    },
    async compact() {
      await resumeRoutedHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
        auth: alice,
        deliveryId: "control_compact",
        kind: "compact",
      });
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

async function withSession(
  billing: BillingProvider,
  body: (session: ReturnType<typeof openSession>) => Promise<void>,
  options: SessionOptions = {},
) {
  sessions += 1;
  billing.options = options;
  await withAgent(
    `model-sign-in-${String(sessions)}`,
    defineAgent({
      model: defineDynamic(() => ({ model: billing.model, modelContextWindowTokens: 200_000 })),
    }),
    body,
    options,
  );
}

interface BillingProvider {
  evictions: number;
  readonly model: ModelDefinition;
  onStart?: () => Promise<void>;
  options: SessionOptions;
  readonly prompts: unknown[];
  starts(): number;
  readonly summaryTokens: string[];
  readonly tokensSeen: string[];
}

function billingProvider(
  initial: {
    readonly token?: string;
    readonly refresh?: string;
    readonly failCompletion?: string;
    readonly rejectEveryToken?: boolean;
    readonly outage?:
      | "getToken"
      | "refresh"
      | "start"
      | "create"
      | "create-output"
      | "create-async";
  } = {},
): BillingProvider {
  let stored = initial.token;
  let issued = 0;
  let starts = 0;
  const auth = {
    principalType: "user",
    vercelConnect: { connector: "oauth/billing" },
    async getToken(): Promise<TokenResult> {
      if (initial.outage === "getToken" || (initial.outage === "refresh" && billing.evictions > 0))
        throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
      if (stored === undefined) throw new ConnectionAuthorizationRequiredError("billing");
      return { token: stored };
    },
    async evict() {
      billing.evictions += 1;
      stored = initial.refresh;
    },
    async startAuthorization({ callbackUrl }) {
      starts += 1;
      if (initial.outage === "start")
        throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
      await billing.onStart?.();
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
  } satisfies AuthorizationDefinition<{ nonce: string }>;
  const billing: BillingProvider = {
    evictions: 0,
    model: defineModel({
      auth,
      create: ({ token }) => {
        if (initial.outage === "create") throw new Error("Missing billing region.");
        if (initial.outage === "create-output") return undefined as never;
        if (initial.outage === "create-async")
          return Promise.resolve(billedModel(billing, token, false)) as never;
        return billedModel(billing, token, initial.rejectEveryToken === true);
      },
      id: "billing/claude",
    }),
    options: {},
    prompts: [],
    starts: () => starts,
    summaryTokens: [],
    tokensSeen: [],
  };
  return billing;
}

function billedModel(billing: BillingProvider, token: string, rejectEveryToken: boolean) {
  const rejected = () => Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        if (JSON.stringify(prompt).includes("previous checkpoint")) {
          billing.summaryTokens.push(token);
          if (token === "stale-token") throw rejected();
          return textStreamResult("Checkpoint: Alice asked for today's issues.");
        }
        billing.tokensSeen.push(token);
        billing.prompts.push(prompt);
        if (rejectEveryToken) throw rejected();
        if (billing.options.bigFirstAnswer === true)
          return billing.tokensSeen.length === 1
            ? bigStreamResult("Here is the summary.")
            : textStreamResult("Here is the summary.");
        if (token === "stale-token" && billing.options.rejectStaleOnlyInSummary !== true)
          throw rejected();
        return textStreamResult("Here is the summary.");
      },
      modelId: "billed-model",
      provider: "eve-test",
    }),
  );
}

function refusedIn(ctx: DynamicModelContext): boolean {
  return interactions(ctx.view).some(
    (asked) =>
      asked.turnId === ctx.turn?.id &&
      asked.request.signIn?.grant === "oauth/billing" &&
      asked.status === "settled" &&
      asked.outcome !== "accepted",
  );
}

function authorizationFailed(message: string) {
  return { error: { code: "MODEL_AUTHORIZATION_FAILED", message }, outcome: "failed" };
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

function rejectingModel() {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async () => {
        throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
      },
      modelId: "docs-model",
      provider: "eve-test",
    }),
  );
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
