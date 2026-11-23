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
import { defineChannel, POST } from "#public/definitions/channel.js";
import { defineDynamic } from "#public/definitions/model.js";
import { defineMemory, defineMemoryProvider } from "#public/memory/index.js";
import { byPrincipal } from "#public/memory/scope.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { always, steered } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

const userAuth: AuthorizationDefinition = {
  principalType: "user",
  getToken: async ({ principal }) => ({
    token: `token-for-${principal.type === "user" ? principal.id : "app"}`,
  }),
};

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
  readonly answer: (
    approver: User | null,
    interactionId: string,
    until?: "response.settled",
  ) => Promise<Stage>;
  readonly reports: AccessReport[];
}

interface ApprovalTaskRun extends SessionRun {
  readonly answer: (approver: User, interactionId: string) => Promise<void>;
  readonly releaseChild: () => void;
}

type Modules = NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"];

async function answerAs(
  commandInbox: string,
  approver: User | null,
  interactionId: string,
): Promise<void> {
  await resumeHook(commandInbox, {
    auth: approver,
    kind: "send",
    delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
    payload: { answers: [{ interactionId, optionId: "approve" }] },
  });
}

async function withSession(
  name: string,
  input: {
    readonly channelKind?: string;
    readonly message: string;
    readonly model: MockLanguageModelV4;
    readonly modules: Modules;
    readonly release?: () => void;
  },
  body: (run: SessionRun) => Promise<void>,
) {
  const channelKind = input.channelKind ?? "http";
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
  const continuationToken = `${channelKind}:${name}`;

  await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: input.message },
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind, continuationToken }),
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
        release: input.release ?? (() => {}),
        async send(auth, message, principalPolicy) {
          await resumeHook(sessionInboxHookToken(continuationToken), {
            auth,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind, channelName: "test" }),
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

function holdOpenTool(gates: readonly Promise<void>[]) {
  const pending = [...gates];
  return {
    loadNamespace: async () => ({
      default: defineTool({
        description: "Wait for the test to release this call.",
        execute: async () => {
          await pending.shift();
          return { released: true };
        },
        inputSchema: {},
      }),
    }),
    logicalPath: "tools/hold_open.ts",
  };
}

function reportAccessTool(
  reports: AccessReport[],
  options: { readonly approval?: Approval; readonly uncaught?: boolean } = {},
) {
  return {
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
  };
}

async function withSteeringRun(
  name: string,
  body: (run: SteeringRun) => Promise<void>,
  options: {
    readonly approval?: Approval;
    readonly channelKind?: string;
    readonly extraModules?: Modules;
    readonly holds?: number;
    readonly model?: MockLanguageModelV4;
    readonly uncaught?: boolean;
  } = {},
) {
  const gates = Array.from({ length: options.holds ?? 1 }, () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  });
  let held = 0;
  const reports: AccessReport[] = [];
  await withSession(
    name,
    {
      channelKind: options.channelKind,
      message: "Use hold_open.",
      model: options.model ?? scriptedModel,
      release: () => gates[held++]?.release(),
      modules: [
        holdOpenTool(gates.map(({ gate }) => gate)),
        reportAccessTool(reports, options),
        ...(options.extraModules ?? []),
      ],
    },
    async (session) => {
      await body({
        ...session,
        reports,
        async answer(approver, interactionId, until) {
          await answerAs(session.commandInbox, approver, interactionId);
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

async function withSignInRun(
  body: (run: SessionRun & { readonly tokens: string[] }) => Promise<void>,
) {
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
      message: "Connect my account.",
      model,
      modules: [
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

async function withSubagentRun(
  body: (run: SessionRun & { readonly reports: AccessReport[] }) => Promise<void>,
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reports: AccessReport[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const raw = JSON.stringify(prompt);
        const first = JSON.stringify(prompt.find((message) => message.role === "user")?.content);
        if (first.includes("CHILD:")) {
          return raw.includes(`"toolName":"report_access"`)
            ? textStreamResult("Child done.")
            : toolCallStreamResult({
                input: "{}",
                toolCallId: "call-report",
                toolName: "report_access",
              });
        }
        const called = (tool: string) => raw.includes(`"toolName":"${tool}"`);
        if (!called("hold_open")) {
          return toolCallStreamResult({
            input: "{}",
            toolCallId: "call-hold_open",
            toolName: "hold_open",
          });
        }
        if (!called("agent")) {
          return toolCallStreamResult({
            input: JSON.stringify({ message: "CHILD: report access." }),
            toolCallId: "call-agent",
            toolName: "agent",
          });
        }
        return called("eve__task_wait")
          ? textStreamResult("Parent done.")
          : toolCallStreamResult({
              input: "{}",
              toolCallId: "call-wait",
              toolName: "eve__task_wait",
            });
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
  await withSession(
    "principal-policy-subagent",
    {
      message: "Use hold_open, then ask the child.",
      model,
      release: () => release(),
      modules: [holdOpenTool([gate]), reportAccessTool(reports)],
    },
    async (session) => {
      await body({ ...session, reports });
    },
  );
}

async function withApprovalTaskRun(body: (run: ApprovalTaskRun) => Promise<void>) {
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const first = JSON.stringify(prompt.find((message) => message.role === "user")?.content);
        const results = prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result" ? [part.toolName] : [],
              )
            : [],
        );
        if (first.includes("CHILD:")) {
          return results.includes("hold_open")
            ? textStreamResult("Child done.")
            : toolCallStreamResult({
                input: "{}",
                toolCallId: "call-child-hold_open",
                toolName: "hold_open",
              });
        }
        if (!results.includes("agent")) {
          return toolCallStreamResult({
            input: JSON.stringify({ message: "CHILD: hold the task open." }),
            toolCallId: "call-agent",
            toolName: "agent",
          });
        }
        if (!results.includes("publish_notes")) {
          return toolCallStreamResult({
            input: "{}",
            toolCallId: "call-publish_notes",
            toolName: "publish_notes",
          });
        }
        const waits = results.filter((name) => name === "eve__task_wait").length;
        const joined = prompt.filter((message) => message.role === "user").length > 1;
        if (waits === 0 || (joined && waits === 1)) {
          return toolCallStreamResult({
            input: "{}",
            toolCallId: `call-wait-${String(waits)}`,
            toolName: "eve__task_wait",
          });
        }
        return textStreamResult("Parent done.");
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
  await withSession(
    "principal-policy-approval-task",
    {
      message: "Start the task, then publish the notes.",
      model,
      modules: [
        holdOpenTool([childGate]),
        {
          loadNamespace: async () => ({
            default: defineTool({
              approval: always(),
              description: "Publish the notes.",
              execute: async () => ({ published: true }),
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/publish_notes.ts",
        },
      ],
    },
    async (session) => {
      await body({
        ...session,
        async answer(approver, interactionId) {
          await answerAs(session.commandInbox, approver, interactionId);
        },
        releaseChild,
      });
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
          const holds = results.filter((name) => name === "hold_open").length;
          const reports = results.filter((name) => name === "report_access").length;
          if (holds === 0) {
            return toolCallStreamResult({
              input: "{}",
              toolCallId: "call-hold_open-1",
              toolName: "hold_open",
            });
          }
          if (reports === 0) {
            return toolCallStreamResult({
              input: "{}",
              toolCallId: "call-report-1",
              toolName: "report_access",
            });
          }
          if (holds === 1) {
            return toolCallStreamResult({
              input: "{}",
              toolCallId: "call-hold_open-2",
              toolName: "hold_open",
            });
          }
          return reports === 1
            ? toolCallStreamResult({
                input: "{}",
                toolCallId: "call-report-2",
                toolName: "report_access",
              })
            : textStreamResult("Done.");
        },
        modelId: "scripted-model",
        provider: "eve-test",
      }),
    );
    const holdOpenCalls = new Set<string>();
    await withSteeringRun(
      "principal-policy-retain",
      async (run) => {
        const started = await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
        await run.send(BOB, "Actually include everyone.", "retain");
        run.release();
        const held = await run.nextUntil("hold_open started again", holdOpenStarted(holdOpenCalls));
        await run.send(ALICE, "Go ahead.");
        run.release();
        const turn = await run.next("turn after the caller spoke");
        const seen = [...started, ...held, ...turn];

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
      },
      { holds: 2, model },
    );
  }, 60_000);

  it("a channel deliver hook sees the retained caller, steeredBy, and payload.auth, and skips byPrincipal capture while steered", async () => {
    const observedDeliveries: {
      readonly current: string | null;
      readonly payloadAuth: string | null | undefined;
      readonly steeredBy: readonly string[] | undefined;
    }[] = [];
    const capturedScopes: string[] = [];
    const channel = defineChannel({
      deliver(payload, ctx) {
        observedDeliveries.push({
          current: ctx.session.auth.current?.principalId ?? null,
          payloadAuth: payload.auth === undefined ? undefined : (payload.auth?.principalId ?? null),
          steeredBy: ctx.session.auth.steeredBy?.map((person) => person.principalId),
        });
      },
      routes: [POST("/messages", async () => new Response(null, { status: 204 }))],
    });
    const personalMemory = defineMemory({
      provider: defineMemoryProvider({
        capture: {
          "turn.completed": async ({ memory }) => {
            capturedScopes.push(memory.scope.key);
          },
        },
        recall: { "turn.started": async () => null },
      }),
      scope: byPrincipal,
    });
    const holdOpenCalls = new Set<string>();
    await withSteeringRun(
      "principal-policy-deliver-and-memory",
      async (run) => {
        await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
        await run.send(BOB, "Actually include everyone.", "retain");
        run.release();
        await run.next("steered turn completed");

        expect(observedDeliveries).toEqual([
          { current: "alice", payloadAuth: "alice", steeredBy: undefined },
          { current: "alice", payloadAuth: "bob", steeredBy: ["bob"] },
        ]);
        expect(run.reports).toEqual([
          { caller: "alice", reason: "turn_steered", steeredBy: ["bob"], token: undefined },
        ]);
        expect(capturedScopes).toEqual([]);
      },
      {
        channelKind: "channel:shared",
        extraModules: [
          { loadNamespace: async () => ({ default: channel }), logicalPath: "channels/shared.ts" },
          {
            loadNamespace: async () => ({ default: personalMemory }),
            logicalPath: "memory/personal.ts",
          },
        ],
      },
    );
  }, 60_000);

  it("a caller's rejected response-policy approval does not clear steeredBy", async () => {
    const holdOpenCalls = new Set<string>();
    await withSteeringRun(
      "principal-policy-rejected-response",
      async (run) => {
        await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
        await run.send(BOB, "Actually include everyone.", "retain");
        run.release();
        const paused = await run.nextUntil(
          "report_access approval",
          (event) => event.type === "interaction.opened" && event.data.request.kind === "approval",
        );
        const approval = filterEventsByType(paused, "interaction.opened").find(
          (event) => event.data.request.kind === "approval",
        )!;

        const refused = await run.answer(ALICE, approval.data.interactionId, "response.settled");
        expect(
          filterEventsByType(refused, "response.settled").map((event) => event.data.outcome),
        ).toEqual(["refused"]);

        await answerAs(run.commandInbox, BOB, approval.data.interactionId);
        await run.nextUntil("turn settled", (event) => event.type === "turn.settled");
        expect(run.reports).toEqual([
          {
            caller: "alice",
            reason: "turn_steered",
            steeredBy: ["bob"],
            token: undefined,
          },
        ]);
      },
      {
        approval: {
          request: always(),
          response: ({ response }) =>
            response.principal.principalId === "bob"
              ? { status: "allowed" }
              : { reason: "Peer approval required.", status: "rejected" },
        },
      },
    );
  }, 60_000);

  it("a held call fails as a tool error the model reads, and the turn goes on", async () => {
    const holdOpenCalls = new Set<string>();
    await withSteeringRun(
      "principal-policy-uncaught",
      async (run) => {
        const started = await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
        await run.send(BOB, "Actually include everyone.", "retain");
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
        await run.send(BOB, "Actually include everyone.", "retain");
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
    await withSignInRun(async (run) => {
      const paused = await run.nextUntil("sign-in hold", (event) => event.type === "turn.paused");
      const signIn = filterEventsByType(paused, "interaction.opened").find(
        (event) => event.data.request.kind === "sign-in",
      )!;
      await run.send(BOB, "Actually include everyone.", "retain");
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
      const events = [...paused, ...consumed, ...ended];

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
      const turns = filterEventsByType(events, "turn.started");
      expect(turns).toHaveLength(2);
      expect(signIn.scope?.turnId).toBe(turns[0]!.data.turnId);
      const bobMessage = filterEventsByType(events, "delivery.consumed").find((event) =>
        textOfDelivery(event).includes("Actually include everyone."),
      );
      expect(bobMessage?.data.turnId).toBe(turns[1]!.data.turnId);
    });
  }, 60_000);

  it("a steered turn's local subagent is held too", async () => {
    const holdOpenCalls = new Set<string>();
    await withSubagentRun(async (run) => {
      const started = await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
      await run.send(BOB, "Actually include everyone.", "retain");
      run.release();
      const turn = await run.nextUntil("parent turn end", (event) => event.type === "turn.settled");
      const seen = [...started, ...turn];

      expect(run.reports).toEqual([
        {
          caller: "alice",
          reason: "turn_steered",
          steeredBy: ["bob"],
          token: undefined,
        },
      ]);
      expect(filterEventsByType(seen, "turn.started")).toHaveLength(1);
    });
  }, 60_000);

  it("the caller's message sent after another person's is read in the same turn", async () => {
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          if (!JSON.stringify(prompt).includes(`"toolName":"hold_open"`)) {
            return toolCallStreamResult({
              input: "{}",
              toolCallId: "call-hold_open",
              toolName: "hold_open",
            });
          }
          const texts = prompt.flatMap((message) =>
            message.role === "user"
              ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
              : [],
          );
          return textStreamResult(`Saw: ${texts.join(" | ")}`);
        },
        modelId: "scripted-model",
        provider: "eve-test",
      }),
    );
    const holdOpenCalls = new Set<string>();
    await withSteeringRun(
      "principal-policy-caller-after-joiner",
      async (run) => {
        const started = await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
        await run.send(BOB, "Bob joins.", "retain");
        await run.send(ALICE, "Alice steers.");
        run.release();
        const turn = await run.next("turn after both messages");
        const seen = [...started, ...turn];

        expect(filterEventsByType(seen, "turn.started")).toHaveLength(1);
        const settled = filterEventsByType(seen, "turn.settled");
        expect(settled).toHaveLength(1);
        expect(settled[0]?.data.outcome).toBe("completed");
        const reply = filterEventsByType(seen, "content.completed").find(
          (event) => event.data.kind === "text" && event.data.phase === "reply",
        )?.data.value;
        expect(reply).toContain("Bob joins.");
        expect(reply).toContain("Alice steers.");
      },
      { model },
    );
  }, 60_000);

  it("a message sent while an approval is open ends a later wait", async () => {
    await withApprovalTaskRun(async (run) => {
      const paused = await run.next("publish_notes approval");
      const approval = filterEventsByType(paused, "interaction.opened").find(
        (event) => event.data.request.kind === "approval",
      )!;
      const turnId = filterEventsByType(paused, "turn.started")[0]!.data.turnId;

      await run.send(BOB, "Bob joins.", "retain");
      await run.answer(ALICE, approval.data.interactionId);
      const read = await run.nextUntil(
        "bob's message read in the wait",
        (event) =>
          event.type === "delivery.consumed" && textOfDelivery(event).includes("Bob joins."),
      );
      const consumed = filterEventsByType(read, "delivery.consumed").find((event) =>
        textOfDelivery(event).includes("Bob joins."),
      );
      expect(consumed?.data.turnId).toBe(turnId);
      expect(filterEventsByType(read, "turn.started")).toEqual([]);
      expect(
        filterEventsByType(read, "call.requested").some(
          (event) => event.data.capability.name === "eve__task_wait",
        ),
      ).toBe(true);

      run.releaseChild();
      const ended = await run.nextUntil("turn end", (event) => event.type === "turn.settled");
      const settled = filterEventsByType(ended, "turn.settled");
      expect(settled).toHaveLength(1);
      expect(settled[0]?.data.outcome).toBe("completed");
      expect(filterEventsByType([...paused, ...read, ...ended], "turn.started")).toHaveLength(1);
    });
  }, 60_000);
});
