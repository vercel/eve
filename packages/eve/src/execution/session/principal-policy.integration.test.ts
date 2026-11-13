import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { Approval } from "#approval/definition.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import type { PrincipalPolicy } from "#channel/types.js";
import {
  ConnectionAuthorizationRequiredError,
  isConnectionAuthorizationFailedError,
} from "#connections/errors.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic } from "#public/definitions/model.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { steered } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

const userAuth: AuthorizationDefinition = {
  principalType: "user",
  getToken: async ({ principal }) => ({
    token: `token-for-${principal.type === "user" ? principal.id : "app"}`,
  }),
};

// Holds Alice's turn open, inside a call, until the test releases it.
const scriptedModel = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const toolResults = prompt.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolName] : []))
          : [],
      );
      if (!toolResults.includes("hold_open")) {
        return toolCallStreamResult({
          input: "{}",
          toolCallId: "call-hold_open",
          toolName: "hold_open",
        });
      }
      const reportResults = prompt.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) =>
              part.type === "tool-result" && part.toolName === "report_access" ? [part] : [],
            )
          : [],
      );
      const users = prompt.filter((message) => message.role === "user").length;
      if (reportResults.length < users - 1) {
        return toolCallStreamResult({
          input: "{}",
          toolCallId: `call-report-${String(reportResults.length)}`,
          toolName: "report_access",
        });
      }
      const latest = reportResults.at(-1);
      return latest?.output.type === "error-text"
        ? textStreamResult(`The tool reported: ${latest.output.value}`)
        : textStreamResult("Done.");
    },
    modelId: "scripted-model",
    provider: "eve-test",
  }),
);

function testUser(principalId: string) {
  return {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId,
    principalType: "user" as const,
  };
}
const ALICE = testUser("alice");
const BOB = testUser("bob");

interface AccessReport {
  readonly caller: string | null;
  readonly reason: string | undefined;
  readonly steeredBy: string[] | undefined;
  readonly token: string | undefined;
}

type User = ReturnType<typeof testUser>;
type Stage = Awaited<ReturnType<ReturnType<typeof captureTurnEvents>["nextTurn"]>>;

interface SessionRun {
  readonly commandInbox: string;
  readonly next: (label: string) => Promise<Stage>;
  readonly nextUntil: (
    label: string,
    matches: (event: SessionStreamEvent) => boolean,
  ) => Promise<Stage>;
  readonly release: () => void;
  readonly send: (auth: User, message: string, principalPolicy?: PrincipalPolicy) => Promise<void>;
}

interface SteeringRun extends SessionRun {
  /** Approves the request with `interactionId` as `approver`. */
  readonly answer: (
    approver: User | null,
    interactionId: string,
    until?: "response.settled",
  ) => Promise<Stage>;
  readonly reports: AccessReport[];
}

type Modules = NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"];

/** Starts an ALICE session with `input` and hands `body` its stream and inbox. */
async function withSession(
  name: string,
  input: {
    readonly message: string;
    readonly model: MockLanguageModelV4;
    readonly modules: Modules;
    readonly release: () => void;
  },
  body: (run: SessionRun) => Promise<void>,
) {
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({
          model: input.model,
          modelContextWindowTokens: 200_000,
        })),
      }),
      name,
    },
    modules: input.modules,
  });
  const continuationToken = `http:${name}`;

  await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: input.message },
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind: "http", continuationToken }),
          "eve.capabilities": { requestInput: true },
        },
      },
    ]);
    const stream = captureTurnEvents(run);
    const next = async (label: string) => {
      return await withTimeout(stream.nextTurn(), label);
    };
    const nextUntil = async (label: string, matches: (event: SessionStreamEvent) => boolean) => {
      return await withTimeout(stream.nextUntil(matches), label);
    };
    try {
      await body({
        commandInbox: sessionInboxHookToken(sessionCommandHookToken(run.runId)),
        next,
        nextUntil,
        release: input.release,
        async send(auth, message, principalPolicy) {
          await resumeHook(sessionInboxHookToken(continuationToken), {
            auth,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            payload: { message },
            ...(principalPolicy !== undefined && { principalPolicy }),
          });
        },
      });
    } finally {
      stream.dispose();
      await run.cancel().catch(() => {});
    }
  });
}

/**
 * Starts a session where Alice asks for hold_open, and hands `body` the run. The model calls
 * hold_open, then report_access once per user message after the first, then replies.
 */
async function withSteeringRun(
  name: string,
  body: (run: SteeringRun) => Promise<void>,
  options: { readonly approval?: Approval; readonly uncaught?: boolean } = {},
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reports: AccessReport[] = [];
  await withSession(
    name,
    {
      message: "Use hold_open.",
      model: scriptedModel,
      release: () => release(),
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Wait for the test to release this call.",
              execute: async () => {
                await gate;
                return { released: true };
              },
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/hold_open.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineTool({
              approval: options.approval,
              description: "Report the identity and token this call may use.",
              execute: async (_input, ctx) => {
                if (options.uncaught === true) {
                  return { token: (await ctx.getToken(userAuth)).token };
                }
                let token: string | undefined;
                let reason: string | undefined;
                try {
                  token = (await ctx.getToken(userAuth)).token;
                } catch (error) {
                  if (!isConnectionAuthorizationFailedError(error)) throw error;
                  reason = error.reason;
                }
                const report = {
                  caller: ctx.session.auth.current?.principalId ?? null,
                  steeredBy: ctx.session.auth.steeredBy?.map((person) => person.principalId),
                  token,
                  reason,
                };
                reports.push(report);
                return report;
              },
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/report_access.ts",
        },
      ],
    },
    async (session) => {
      await body({
        ...session,
        reports,
        async answer(approver, interactionId, until) {
          await resumeHook(session.commandInbox, {
            auth: approver,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            payload: { answers: [{ interactionId, optionId: "approve" }] },
          });
          return until === "response.settled"
            ? await session.nextUntil(
                "refused answer",
                (event) => event.type === "response.settled",
              )
            : await session.next("approved");
        },
      });
    },
  );
  return { reports };
}

/**
 * Starts a session where Alice asks for hold_open then connect_account. hold_open waits for the
 * test's release; connect_account opens Alice's sign-in until its callback completes.
 */
async function withSignInRun(
  body: (run: SessionRun & { readonly tokens: string[] }) => Promise<void>,
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tokens: string[] = [];
  let signedIn = false;
  const connectAuth: AuthorizationDefinition<{ nonce: string }> = {
    principalType: "user",
    async getToken({ principal }) {
      if (!signedIn) throw new ConnectionAuthorizationRequiredError("connect");
      return { token: `token-for-${principal.type === "user" ? principal.id : "app"}` };
    },
    async startAuthorization({ callbackUrl }) {
      return {
        challenge: {
          displayName: "Account",
          url: `https://idp.example/authorize?cb=${encodeURIComponent(callbackUrl)}`,
        },
        resume: { nonce: "connect-nonce" },
      };
    },
    async completeAuthorization({ callback }) {
      expect(callback.params.code).toBe("oauth-code");
      signedIn = true;
      return { token: "token-for-alice" };
    },
  };
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const results = prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result" ? [part.toolName] : [],
              )
            : [],
        );
        if (!results.includes("hold_open")) {
          return toolCallStreamResult({
            input: "{}",
            toolCallId: "call-hold_open",
            toolName: "hold_open",
          });
        }
        return results.includes("connect_account")
          ? textStreamResult("Done.")
          : toolCallStreamResult({
              input: "{}",
              toolCallId: "call-connect_account",
              toolName: "connect_account",
            });
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
  await withSession(
    "principal-policy-sign-in",
    {
      message: "Use hold_open, then connect the account.",
      model,
      release: () => release(),
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Wait for the test to release this call.",
              execute: async () => {
                await gate;
                return { released: true };
              },
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/hold_open.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Connect the caller's account.",
              execute: async (_input, ctx) => {
                const token = (
                  await ctx.getToken(connectAuth, {
                    authKey: "connect",
                    displayName: "Account",
                  })
                ).token;
                tokens.push(token);
                return { token };
              },
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/connect_account.ts",
        },
      ],
    },
    async (session) => {
      await body({ ...session, tokens });
    },
  );
}

function holdOpenStarted(holdOpenCalls: Set<string>) {
  return (event: SessionStreamEvent): boolean => {
    if (event.type === "call.requested" && event.data.capability.name === "hold_open") {
      holdOpenCalls.add(event.data.callId);
    }
    return event.type === "call.started" && holdOpenCalls.has(event.data.callId);
  };
}

function textOfDelivery(event: Extract<SessionEvent, { type: "delivery.consumed" }>) {
  return event.data.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
}

describe("principal policy", () => {
  it("the identity hold lasts until the caller's own message in the same turn", async () => {
    const holdOpenCalls = new Set<string>();
    await withSteeringRun("principal-policy-retain-caller", async (run) => {
      const started = await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
      await run.send(BOB, "Actually include everyone.", "retain-caller");
      await run.send(ALICE, "Go ahead.");
      run.release();
      const turn = await run.next("turn after both messages");
      const seen = [...started, ...turn];

      expect(run.reports).toEqual([
        {
          caller: "alice",
          reason: "turn_steered",
          steeredBy: ["bob"],
          token: undefined,
        },
        {
          caller: "alice",
          reason: undefined,
          steeredBy: undefined,
          token: "token-for-alice",
        },
      ]);
      const turns = filterEventsByType(seen, "turn.started");
      expect(turns).toHaveLength(1);
      const steered = filterEventsByType(seen, "delivery.consumed").find((event) =>
        textOfDelivery(event).includes("Actually include everyone."),
      );
      expect(steered?.data.turnId).toBe(turns[0]!.data.turnId);
    });
  }, 60_000);

  it("an adopt-sender message makes its sender the turn's caller", async () => {
    const holdOpenCalls = new Set<string>();
    await withSteeringRun("principal-policy-adopt-sender", async (run) => {
      const started = await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
      await run.send(BOB, "Actually include everyone.", "adopt-sender");
      await run.send(BOB, "And add a summary.");
      run.release();
      const turn = await run.next("turn after both messages");
      const seen = [...started, ...turn];

      expect(run.reports).toEqual([
        {
          caller: "bob",
          reason: undefined,
          steeredBy: undefined,
          token: "token-for-bob",
        },
        {
          caller: "bob",
          reason: undefined,
          steeredBy: undefined,
          token: "token-for-bob",
        },
      ]);
      const turns = filterEventsByType(seen, "turn.started");
      expect(turns).toHaveLength(1);
      const bobMessages = filterEventsByType(seen, "delivery.consumed").filter((event) =>
        textOfDelivery(event).some((text) =>
          ["Actually include everyone.", "And add a summary."].includes(text),
        ),
      );
      expect(bobMessages.map((event) => event.data.turnId)).toEqual([
        turns[0]!.data.turnId,
        turns[0]!.data.turnId,
      ]);
    });
  }, 60_000);

  // The other cases catch turn_steered inside the tool, so only this one proves the failure
  // reaches the model.
  it("a held call fails as a tool error the model reads, and the turn goes on", async () => {
    const holdOpenCalls = new Set<string>();
    await withSteeringRun(
      "principal-policy-uncaught",
      async (run) => {
        const started = await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
        await run.send(BOB, "Actually include everyone.", "retain-caller");
        run.release();
        const turn = await run.next("turn after the failed call");
        const seen = [...started, ...turn];

        expect(run.reports).toEqual([]);
        const reportCall = filterEventsByType(seen, "call.requested").find(
          (event) => event.data.capability.name === "report_access",
        )?.data.callId;
        expect(reportCall).toBeDefined();
        expect(
          filterEventsByType(seen, "call.settled").find((event) => event.data.callId === reportCall)
            ?.data.outcome,
        ).toBe("failed");
        const reply = filterEventsByType(seen, "content.completed").find(
          (event) => event.data.kind === "text" && event.data.phase === "reply",
        )?.data.value;
        expect(typeof reply).toBe("string");
        expect(reply).toContain(
          "Another person's message joined this turn after its caller last spoke",
        );
        expect(reply).toContain(`tool "report_access" can't use the caller's identity`);
        expect(reply).not.toContain("bob");
        expect(filterEventsByType(seen, "turn.started")).toHaveLength(1);
        const settled = filterEventsByType(seen, "turn.settled");
        expect(settled).toHaveLength(1);
        expect(settled[0]?.data.outcome).toBe("completed");
        expect(filterEventsByType(seen, "interaction.opened")).toEqual([]);
      },
      { uncaught: true },
    );
  }, 60_000);

  it("steered() asks only the turn's caller, and the caller's approval releases the identity", async () => {
    const holdOpenCalls = new Set<string>();
    await withSteeringRun(
      "principal-policy-steered-approval",
      async (run) => {
        await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
        await run.send(BOB, "Actually include everyone.", "retain-caller");
        run.release();
        const paused = await run.nextUntil(
          "report_access approval",
          (event) => event.type === "interaction.opened" && event.data.request.kind === "approval",
        );
        expect(run.reports).toEqual([]);
        const approval = filterEventsByType(paused, "interaction.opened").find(
          (event) => event.data.request.kind === "approval",
        )!;

        const refused = await run.answer(BOB, approval.data.interactionId, "response.settled");
        expect(
          filterEventsByType(refused, "response.settled").map((event) => event.data.outcome),
        ).toEqual(["refused"]);
        expect(run.reports).toEqual([]);

        await run.answer(ALICE, approval.data.interactionId);
        expect(run.reports).toEqual([
          {
            caller: "alice",
            reason: undefined,
            steeredBy: undefined,
            token: "token-for-alice",
          },
        ]);
      },
      { approval: steered() },
    );
  }, 60_000);

  it("without a join policy, another person's message waits for the turn to end", async () => {
    const holdOpenCalls = new Set<string>();
    await withSteeringRun("principal-policy-queue", async (run) => {
      const started = await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
      await run.send(BOB, "Actually include everyone.");
      run.release();
      const turn = await run.next("alice's turn");
      const seen = [...started, ...turn];
      expect(run.reports).toEqual([]);
      expect(filterEventsByType(seen, "turn.started")).toHaveLength(1);

      const bobTurn = await run.next("bob's turn");
      const all = [...seen, ...bobTurn];
      const turns = filterEventsByType(all, "turn.started");
      expect(turns).toHaveLength(2);
      const steered = filterEventsByType(all, "delivery.consumed").find((event) =>
        textOfDelivery(event).includes("Actually include everyone."),
      );
      expect(steered?.data.turnId).toBe(turns[1]!.data.turnId);
      expect(run.reports).toEqual([
        {
          caller: "bob",
          reason: undefined,
          steeredBy: undefined,
          token: "token-for-bob",
        },
      ]);
    });
  }, 60_000);

  it("another person's message waits while the caller's sign-in is open", async () => {
    const holdOpenCalls = new Set<string>();
    await withSignInRun(async (run) => {
      const started = await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
      await run.send(ALICE, "Go ahead and connect.");
      await run.send(BOB, "Actually include everyone.", "retain-caller");
      run.release();
      const asked = await run.nextUntil(
        "sign-in opened",
        (event) => event.type === "interaction.opened" && event.data.request.kind === "sign-in",
      );
      const held = await run.nextUntil("sign-in hold", (event) => event.type === "turn.paused");
      const signIn = filterEventsByType(asked, "interaction.opened").find(
        (event) => event.data.request.kind === "sign-in",
      )!;
      await resumeHook(run.commandInbox, {
        kind: "authorization-callback",
        payloads: [
          {
            authorizationCallback: {
              attemptId: signIn.data.interactionId,
              callback: { method: "GET", params: { code: "oauth-code" } },
              connectionName: signIn.data.request.signIn!.name,
            },
          },
        ],
      });
      const consumed = await run.nextUntil(
        "bob's message consumed",
        (event) =>
          event.type === "delivery.consumed" &&
          textOfDelivery(event).includes("Actually include everyone."),
      );
      const ended = await run.nextUntil("turn end", (event) => event.type === "turn.settled");
      const events = [...started, ...asked, ...held, ...consumed, ...ended];

      expect(run.tokens).toEqual(["token-for-alice"]);
      const connectCall = filterEventsByType(events, "call.requested").find(
        (event) => event.data.capability.name === "connect_account",
      )?.data.callId;
      expect(
        filterEventsByType(events, "call.settled").find(
          (event) => event.data.callId === connectCall,
        )?.data.outcome,
      ).toBe("completed");
      const signedInAt = events.findIndex(
        (event) =>
          event.type === "interaction.settled" &&
          event.data.interactionId === signIn.data.interactionId,
      );
      const consumedAt = events.findIndex(
        (event) =>
          event.type === "delivery.consumed" &&
          textOfDelivery(event).includes("Actually include everyone."),
      );
      expect(signedInAt).toBeGreaterThanOrEqual(0);
      expect(consumedAt).toBeGreaterThan(signedInAt);
      // Alice's turn ended before Bob's message was read, so it started its own turn.
    });
  }, 60_000);
});
