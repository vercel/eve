import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { Approval } from "#approval/definition.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
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

interface SteeringRun {
  /** Approves the request with `interactionId` as `approver`. */
  readonly answer: (
    approver: User | null,
    interactionId: string,
    until?: "response.settled",
  ) => Promise<Stage>;
  readonly next: (label: string) => Promise<Stage>;
  readonly nextUntil: (
    label: string,
    matches: (event: SessionStreamEvent) => boolean,
  ) => Promise<Stage>;
  readonly release: () => void;
  readonly reports: AccessReport[];
  readonly send: (auth: User, message: string, principalPolicy?: "keep") => Promise<void>;
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
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({
          model: scriptedModel,
          modelContextWindowTokens: 200_000,
        })),
      }),
      name,
    },
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
  });
  const continuationToken = `http:${name}`;

  await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Use hold_open." },
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind: "http", continuationToken }),
          "eve.capabilities": { requestInput: true },
        },
      },
    ]);
    const commandInbox = sessionInboxHookToken(sessionCommandHookToken(run.runId));
    const stream = captureTurnEvents(run);
    const next = async (label: string) => {
      return await withTimeout(stream.nextTurn(), label);
    };
    const nextUntil = async (label: string, matches: (event: SessionStreamEvent) => boolean) => {
      return await withTimeout(stream.nextUntil(matches), label);
    };
    try {
      await body({
        reports,
        next,
        nextUntil,
        release: () => {
          release();
        },
        async send(auth, message, principalPolicy) {
          await resumeHook(sessionInboxHookToken(continuationToken), {
            auth,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            payload: { message },
            ...(principalPolicy !== undefined && { principalPolicy }),
          });
        },
        async answer(approver, interactionId, until) {
          await resumeHook(commandInbox, {
            auth: approver,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            payload: { answers: [{ interactionId, optionId: "approve" }] },
          });
          return until === "response.settled"
            ? await nextUntil("refused answer", (event) => event.type === "response.settled")
            : await next("approved");
        },
      });
    } finally {
      stream.dispose();
      await run.cancel().catch(() => {});
    }
  });
  return { reports };
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
  it("another person's keep message joins the turn, which holds its caller's identity until the caller speaks", async () => {
    const holdOpenCalls = new Set<string>();
    await withSteeringRun("principal-policy-keep", async (run) => {
      const started = await run.nextUntil("hold_open started", holdOpenStarted(holdOpenCalls));
      await run.send(BOB, "Actually include everyone.", "keep");
      run.release();
      const turn = await run.next("turn after the steering message");
      const seen = [...started, ...turn];

      expect(run.reports).toEqual([
        {
          caller: "alice",
          reason: "turn_steered",
          steeredBy: ["bob"],
          token: undefined,
        },
      ]);
      const turns = filterEventsByType(seen, "turn.started");
      expect(turns).toHaveLength(1);
      const steered = filterEventsByType(seen, "delivery.consumed").find((event) =>
        textOfDelivery(event).includes("Actually include everyone."),
      );
      expect(steered?.data.turnId).toBe(turns[0]!.data.turnId);

      await run.send(ALICE, "Go ahead.");
      await run.next("caller's message");
      expect(run.reports[1]).toEqual({
        caller: "alice",
        reason: undefined,
        steeredBy: undefined,
        token: "token-for-alice",
      });
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
        await run.send(BOB, "Actually include everyone.", "keep");
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
        expect(reply).toContain("A message from bob joined this turn after its caller last spoke");
        expect(reply).toContain(`tool "report_access" can't use the caller's identity`);
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
        await run.send(BOB, "Actually include everyone.", "keep");
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

  it("without keep, another person's message waits for the turn to end", async () => {
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
});
