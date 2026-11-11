import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { markMockModel } from "#internal/mock-model-identity.js";
import {
  textStreamResult,
  toolCallStreamResult,
  toolCallsStreamResult,
} from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { defineDynamic } from "#public/definitions/model.js";
import type { Approval, ApprovalPolicy, ApprovalResponsePolicy } from "#approval/definition.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { always, steered } from "#tools/approval/policies.js";
import { defineTool, type ToolAuthProvider } from "#tools/definition.js";
import {
  type WorkflowExecuteToolDefinition,
  defineWorkflowTool,
} from "#tools/workflow-definition.js";
import {
  reportCallerWorkflow,
  reportSenderWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { STUB_CONTEXT_KEY, type ToolStub } from "#tool-stubs/types.js";

// Scripted model: calls each tool the first message names, in the order it
// names them, once each, then replies. "in parallel" calls them all in one step.
const scriptedModel = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt, tools }) => {
      const first = JSON.stringify(prompt.find((message) => message.role === "user")?.content);
      const chain = (tools ?? [])
        .map((tool) => tool.name)
        .filter((name) => first.includes(name))
        .sort((a, b) => first.indexOf(a) - first.indexOf(b));
      const done = new Set(
        prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result" ? [part.toolName] : [],
              )
            : [],
        ),
      );
      if (first.includes("in parallel")) {
        return done.size > 0
          ? textStreamResult("All done.")
          : toolCallsStreamResult(
              chain.map((name) => ({ input: "{}", toolCallId: `call-${name}`, toolName: name })),
            );
      }
      const next = chain.find((name) => !done.has(name));
      return next === undefined
        ? textStreamResult("All done.")
        : toolCallStreamResult({ input: "{}", toolCallId: `call-${next}`, toolName: next });
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

// Without a response policy only the requester may respond, and these tests
// need Bob to approve Alice's calls.
const anyoneResponds: ApprovalResponsePolicy = () => ({ status: "allowed" });

/**
 * Records `ctx.session.auth.current` for every tool that runs, and in `approvedBy` who
 * approved each call that ran after an approval.
 */
function recordingTool(
  name: string,
  seen: Array<{ tool: string; caller: string | null }>,
  log: string[],
  approval?: Approval,
  approvedBy?: Array<{ tool: string; responder: string }>,
) {
  return {
    loadNamespace: async () => ({
      default: defineTool({
        approval,
        description: `Run ${name}.`,
        execute: async (_input, ctx) => {
          log.push(`start ${name}`);
          // Yield so calls running in parallel interleave before reading the caller.
          await new Promise((resolve) => setTimeout(resolve, 20));
          seen.push({ tool: name, caller: ctx.session.auth.current?.principalId ?? null });
          if (ctx.approval !== undefined) {
            approvedBy?.push({ tool: name, responder: ctx.approval.responder.principalId });
          }
          log.push(`end ${name}`);
          return { ran: name };
        },
        inputSchema: {},
      }),
    }),
    logicalPath: `tools/${name}.ts`,
  };
}

/** A per-user credential: each person's token names them, so a result shows whose was used. */
const CALLER_TOKEN: ToolAuthProvider = {
  principalType: "user",
  getToken: async ({ principal }) => ({
    token: `token:${principal.type === "user" ? principal.id : "app"}`,
  }),
};

/**
 * A tool that returns the token of the caller, or of the person `as` names, and who it reads as the
 * last to speak.
 */
function tokenTool(name: string, { approval, as }: { approval?: Approval; as?: string } = {}) {
  return {
    loadNamespace: async () => ({
      default: defineTool({
        approval,
        description: `Run ${name} with ${as ?? "the caller"}'s token.`,
        execute: async (_input, ctx) => {
          const { token } = await ctx.getToken(CALLER_TOKEN, { as });
          return `${token}, sender ${ctx.session.auth.sender?.principalId}`;
        },
        inputSchema: {},
      }),
    }),
    logicalPath: `tools/${name}.ts`,
  };
}

/** A workflow tool anyone may approve, which runs `execute`. */
function workflowTool(
  name: string,
  execute: typeof reportCallerWorkflow | typeof reportSenderWorkflow,
) {
  return {
    loadNamespace: async () => ({
      default: defineWorkflowTool({
        approval: { request: always(), response: anyoneResponds },
        description: `Run ${name}.`,
        execute: execute as WorkflowExecuteToolDefinition["execute"],
        inputSchema: {},
      }),
    }),
    logicalPath: `tools/${name}.ts`,
  };
}

type User = ReturnType<typeof testUser>;
type Stage = Awaited<ReturnType<ReturnType<typeof captureTurnEvents>["nextTurn"]>>;

interface ChainRun {
  /**
   * Approves the pending request for `toolName`, or the first one, and reads to the turn's next
   * boundary, or to the answer's `response.settled` for one the session refuses.
   */
  readonly approve: (
    approver: User | null,
    toolName?: string,
    until?: "response.settled",
  ) => Promise<Stage>;
  /** Reads the session's next turn segment. */
  readonly next: (label: string) => Promise<Stage>;
  /**
   * Sends `payload` as one delivery on the session's command inbox, and reads to the turn's
   * next boundary, or to the `response.settled` of an answer the session refuses.
   */
  readonly deliver: (
    auth: User,
    payload: Record<string, unknown>,
    until?: "response.settled",
  ) => Promise<Stage>;
  readonly send: (auth: User, message: string) => Promise<Stage>;
  /** Completes the sign-in `attemptId` for `connectionName`, as its provider's redirect does. */
  readonly signIn: (attemptId: string, connectionName: string) => Promise<Stage>;
  readonly stages: Stage[];
}

/**
 * Starts a session where Alice asks for deploy_change, read_notes, then
 * publish_change, the first and last gated, and hands `body` the run.
 */
async function withChainRun(
  name: string,
  body: (run: ChainRun) => Promise<void>,
  options: {
    /** The agent's approval policy, which every call runs under. */
    readonly approval?: ApprovalPolicy;
    readonly firstApproval?: Approval;
    readonly message?: string;
    readonly stubs?: readonly ToolStub[];
    readonly model?: MockLanguageModelV4;
    readonly modules?: NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"];
  } = {},
) {
  const seen: Array<{ tool: string; caller: string | null }> = [];
  const approvedBy: Array<{ tool: string; responder: string }> = [];
  const log: string[] = [];
  const secondRequesters: Array<string | null> = [];
  const secondApproval: Approval = {
    request: always(),
    response: ({ request }) => {
      secondRequesters.push(request.principal?.principalId ?? null);
      return { status: "allowed" };
    },
  };
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        ...(options.approval !== undefined && { approval: options.approval }),
        model: defineDynamic(() => ({
          model: options.model ?? scriptedModel,
          modelContextWindowTokens: 200_000,
        })),
      }),
      name,
    },
    modules: [
      recordingTool(
        "deploy_change",
        seen,
        log,
        options.firstApproval ?? { request: always(), response: anyoneResponds },
        approvedBy,
      ),
      recordingTool("read_notes", seen, log, undefined, approvedBy),
      recordingTool("publish_change", seen, log, secondApproval, approvedBy),
      ...(options.modules ?? []),
    ],
  });
  const continuationToken = `http:${name}`;
  const stages: Stage[] = [];

  await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: {
          message: options.message ?? "Use deploy_change, then read_notes, then publish_change.",
        },
        serializedContext: {
          ...buildSerializedContext({ auth: ALICE, channelKind: "http", continuationToken }),
          "eve.capabilities": { requestInput: true },
          ...(options.stubs === undefined
            ? {}
            : { [STUB_CONTEXT_KEY]: { token: `${name}-stubs`, rules: options.stubs } }),
        },
      },
    ]);
    const commandInbox = sessionInboxHookToken(sessionCommandHookToken(run.runId));
    const stream = captureTurnEvents(run);
    const next = async (label: string) => {
      const stage = await withTimeout(stream.nextTurn(), label);
      stages.push(stage);
      return stage;
    };
    try {
      await next("first approval");
      await body({
        next,
        stages,
        async approve(approver, toolName, until) {
          const request = approvalsIn(stages)
            .filter((entry) => toolName === undefined || entry.toolName === toolName)
            .at(toolName === undefined ? -1 : 0);
          expect(request).toBeDefined();
          await resumeHook(commandInbox, {
            auth: approver,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            payload: {
              answers: [{ interactionId: request!.interactionId, optionId: "approve" }],
            },
          });
          // A refused answer changes nothing the turn waits on, so it announces no pause.
          if (until === "response.settled") {
            const stage = await withTimeout(
              stream.nextUntil((event) => event.type === "response.settled"),
              "refused",
            );
            stages.push(stage);
            return stage;
          }
          return await next("approved");
        },
        async deliver(auth, payload, until) {
          await resumeHook(commandInbox, {
            auth,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            payload,
          });
          if (until === "response.settled") {
            const stage = await withTimeout(
              stream.nextUntil((event) => event.type === "response.settled"),
              "refused",
            );
            stages.push(stage);
            return stage;
          }
          return await next("delivered");
        },
        async signIn(attemptId, connectionName) {
          await resumeHook(commandInbox, {
            kind: "authorization-callback",
            payloads: [
              {
                authorizationCallback: {
                  attemptId,
                  callback: { method: "GET", params: { code: "oauth-code" } },
                  connectionName,
                },
              },
            ],
          });
          return await next("signed in");
        },
        async send(auth, message) {
          await resumeHook(sessionInboxHookToken(continuationToken), {
            auth,
            kind: "send",
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            payload: { message },
          });
          return await next("message");
        },
      });
    } finally {
      stream.dispose();
      await run.cancel().catch(() => {});
    }
  });
  return { approvedBy, log, secondRequesters, seen, stages };
}

function turnBoundaries(stage: Stage) {
  return stage
    .filter((event) => event.type === "turn.started" || event.type === "turn.settled")
    .map((event) => `${event.type} ${(event.data as { turnId: string }).turnId}`);
}

/** The approvals the stages opened, oldest first, with the tool each asks to call. */
function approvalsIn(stages: readonly Stage[]) {
  const events = stages.flat();
  const toolOf = new Map(
    filterEventsByType(events, "call.requested").map((event) => [
      event.data.callId,
      event.data.capability.name,
    ]),
  );
  return filterEventsByType(events, "interaction.opened")
    .filter((event) => event.data.request.kind === "approval")
    .map((event) => {
      const callId = "callId" in event.data.subject ? event.data.subject.callId : undefined;
      return {
        interactionId: event.data.interactionId,
        toolName: callId === undefined ? undefined : toolOf.get(callId),
      };
    });
}

/** The output each settlement of `callId` carries, in order. */
function outputsOf(stages: readonly Stage[], callId: string) {
  return stages
    .flat()
    .flatMap((event) =>
      event.type === "call.settled" && event.data.callId === callId ? [event.data.output] : [],
    );
}

/** eve's requests for a person's identity the stages opened, oldest first. */
function identityAsks(stages: readonly Stage[]) {
  return filterEventsByType(stages.flat(), "interaction.opened")
    .filter((event) => event.data.audience !== undefined && event.data.request.kind === "approval")
    .map((event) => ({
      audience: event.data.audience,
      callId: "callId" in event.data.subject ? event.data.subject.callId : undefined,
      interactionId: event.data.interactionId,
      prompt: event.data.request.prompt,
    }));
}

/** Answers eve's request for a person's identity about `callId`. */
function answerIdentity(
  run: ChainRun,
  callId: string,
  auth: User,
  optionId: "approve" | "deny",
  until?: "response.settled",
) {
  const ask = identityAsks(run.stages)
    .filter((entry) => entry.callId === callId)
    .at(-1);
  expect(ask).toBeDefined();
  return run.deliver(auth, { answers: [{ interactionId: ask!.interactionId, optionId }] }, until);
}

describe("approval caller", () => {
  it.each([false, true])(
    "runs a call another person approves as its requester (unmatched stub: %s)",
    async (withStub) => {
      const { approvedBy, secondRequesters, seen, stages } = await withChainRun(
        `approval-caller-${withStub}`,
        async (run) => {
          await run.approve(BOB);
          await run.approve(ALICE);
        },
        {
          stubs: withStub
            ? [
                {
                  id: "other-deployment",
                  tool: "deploy_change",
                  match: { environment: { const: "other" } },
                  outcome: { response: { ran: "stubbed" } },
                },
              ]
            : undefined,
        },
      );

      // Bob's approval resumes Alice's turn; it does not start his own.
      expect(stages.map(turnBoundaries)).toEqual([
        ["turn.started turn_0"],
        [],
        ["turn.settled turn_0"],
      ]);
      expect(seen).toEqual([
        { tool: "deploy_change", caller: "alice" },
        { tool: "read_notes", caller: "alice" },
        { tool: "publish_change", caller: "alice" },
      ]);
      expect(secondRequesters).toEqual(["alice"]);
      // Each approved call reads who approved it; the call that needed no approval reads nobody.
      expect(approvedBy).toEqual([
        { tool: "deploy_change", responder: "bob" },
        { tool: "publish_change", responder: "alice" },
      ]);
    },
    60_000,
  );

  it("after someone else speaks, hands the caller's token to a call the caller approved, which reads the caller as its sender", async () => {
    const { stages } = await withChainRun(
      "approval-caller-token-approved",
      async (run) => {
        // Bob's message joins Alice's turn while deploy_change waits on her approval, which
        // waits as a task: he spoke last from then on.
        await run.send(BOB, "Bob adds a note.");
        await run.approve(ALICE, "use_token");
      },
      {
        message: "Use deploy_change, then use_token, then use_token_again.",
        modules: [tokenTool("use_token", { approval: always() }), tokenTool("use_token_again")],
      },
    );

    expect(outputsOf(stages, "call-use_token")).toEqual(["token:alice, sender alice"]);
    // Approving the tool covers only its call; only approving eve's request for her identity
    // covers her later calls. So the next one asks Alice for her identity.
    expect(identityAsks(stages)).toMatchObject([
      { callId: "call-use_token_again", audience: { principalIds: ["alice"] } },
    ]);
    expect(outputsOf(stages, "call-use_token_again")).toEqual([]);
  }, 60_000);

  it("hands the caller's token to a call that waited on their approval after someone else spoke", async () => {
    const { stages } = await withChainRun(
      "approval-caller-waiting-token",
      async (run) => {
        // use_token was asked while Alice spoke last. Bob's message joins, and the call waits.
        await run.send(BOB, "Bob adds a note.");
        await run.approve(ALICE, "use_token");
      },
      { message: "Use use_token.", modules: [tokenTool("use_token", { approval: always() })] },
    );

    expect(outputsOf(stages, "call-use_token")).toEqual(["token:alice, sender alice"]);
  }, 60_000);

  it("asks the caller for a call someone else approved, which waited as a task with the sender it was asked under", async () => {
    const { stages } = await withChainRun(
      "approval-caller-asked-sender",
      async (run) => {
        // use_token is asked after Bob spoke; Alice's message, read before anyone approves it,
        // doesn't change that.
        await run.send(BOB, "Bob adds a note.");
        await run.send(ALICE, "Alice agrees.");
        // Bob approves it through the response policy, which doesn't release Alice's token: the
        // call stops and asks her.
        await run.approve(BOB, "use_token");
        await run.approve(ALICE, "deploy_change");
      },
      {
        message: "Use deploy_change, then use_token.",
        modules: [
          tokenTool("use_token", { approval: { request: always(), response: anyoneResponds } }),
        ],
      },
    );

    expect(identityAsks(stages)).toMatchObject([
      { callId: "call-use_token", audience: { principalIds: ["alice"] } },
    ]);
    expect(outputsOf(stages, "call-use_token")).toEqual([]);
  }, 60_000);

  it.each([
    // Alice's message, read before Bob approves, doesn't change the sender the call was asked under.
    { aliceAgrees: true, approver: BOB, sender: "bob" },
    // The caller approving the call makes them its sender.
    { aliceAgrees: false, approver: ALICE, sender: "alice" },
  ])(
    "after someone else speaks, starts a waiting workflow tool's run with the sender it was asked under, or the caller when they approve it: $sender",
    async ({ aliceAgrees, approver, sender }) => {
      const { stages } = await withChainRun(
        `approval-caller-workflow-sender-${sender}`,
        async (run) => {
          // Bob's message joins Alice's turn while deploy_change waits as a task: he spoke last
          // from then on.
          await run.send(BOB, "Bob adds a note.");
          if (aliceAgrees) await run.send(ALICE, "Alice agrees.");
          await run.approve(approver, "report_sender");
          await run.approve(ALICE, "deploy_change");
        },
        {
          message: "Use deploy_change, then report_sender.",
          modules: [workflowTool("report_sender", reportSenderWorkflow)],
        },
      );

      expect(outputsOf(stages, "call-report_sender")).toEqual([{ sender }]);
    },
    60_000,
  );

  it("keeps a step's other approval open when a message arrives with one answer", async () => {
    const { seen, stages } = await withChainRun(
      "approval-caller-steer-with-answer",
      async (run) => {
        const publish = approvalsIn(run.stages).find(
          (entry) => entry.toolName === "publish_change",
        );
        expect(approvalsIn(run.stages)).toHaveLength(2);
        // publish_change waits for its response policy; deploy_change has none. The message
        // queues behind the policy's answer, and deploy_change then waits as a task.
        await run.deliver(ALICE, {
          answers: [{ interactionId: publish!.interactionId, optionId: "approve" }],
          message: "Go ahead with publishing; the deploy can wait.",
        });
      },
      { firstApproval: always(), message: "Call in parallel: deploy_change, publish_change." },
    );

    const outcomes = Object.fromEntries(
      filterEventsByType(stages.flat(), "interaction.settled").map((event) => [
        event.data.interactionId,
        event.data.outcome,
      ]),
    );
    const byTool = Object.fromEntries(
      approvalsIn(stages).map((entry) => [entry.toolName, outcomes[entry.interactionId]]),
    );
    expect(byTool).toEqual({ deploy_change: undefined, publish_change: "accepted" });
    expect(seen).toEqual([{ tool: "publish_change", caller: "alice" }]);
    expect(filterEventsByType(stages.at(-1)!, "turn.paused").at(-1)?.data.awaiting).toEqual([
      {
        interactionId: approvalsIn(stages).find((e) => e.toolName === "deploy_change")!
          .interactionId,
      },
    ]);
  }, 60_000);

  it("starts an approved workflow tool's run as its requester", async () => {
    const { stages } = await withChainRun(
      "approval-caller-workflow",
      async (run) => {
        await run.approve(BOB);
      },
      {
        message: "Use report_caller, then read_notes.",
        modules: [workflowTool("report_caller", reportCallerWorkflow)],
      },
    );

    expect(outputsOf(stages, "call-report_caller")).toEqual([{ caller: "alice" }]);
  }, 60_000);

  it("answers the requester's next message after another person's press ends the turn", async () => {
    const { stages } = await withChainRun(
      "approval-caller-press-state",
      async (run) => {
        const request = approvalsIn(run.stages)[0]!;
        // A channel's press carries its own state beside the answer, such as who pressed.
        await run.deliver(BOB, {
          answers: [{ interactionId: request.interactionId, optionId: "approve" }],
          state: { triggeringUserId: "bob" },
        });
        await run.send(ALICE, "Thanks, that's all.");
      },
      { message: "Use deploy_change, then read_notes." },
    );

    expect(stages.map(turnBoundaries)).toEqual([
      ["turn.started turn_0"],
      ["turn.settled turn_0"],
      ["turn.started turn_1", "turn.settled turn_1"],
    ]);
  }, 60_000);

  it("keeps another person's approval theirs when their delivery also carries a stale answer", async () => {
    const turnAuth: Array<string | null> = [];
    const { seen, stages } = await withChainRun(
      "approval-caller-stale-mixed",
      async (run) => {
        const request = approvalsIn(run.stages)[0]!;
        // Requester-only: Bob's answer can't settle Alice's call, even beside a stale one.
        const refused = await run.deliver(
          BOB,
          {
            answers: [
              {
                interactionId: "answered-earlier",
                optionId: "approve",
                text: "Also drop the staging db.",
              },
              { interactionId: request.interactionId, optionId: "approve" },
            ],
          },
          "response.settled",
        );
        expect(filterEventsByType(refused, "interaction.settled")).toEqual([]);
        await run.approve(ALICE, "deploy_change");
        await run.approve(ALICE, "publish_change");
      },
      {
        firstApproval: always(),
        modules: [
          {
            logicalPath: "hooks/turn-auth.ts",
            loadNamespace: async () => ({
              default: defineHook({
                events: {
                  "response.settled"(_event, ctx) {
                    turnAuth.push(ctx.session.auth.current?.principalId ?? null);
                  },
                  "turn.paused"(_event, ctx) {
                    turnAuth.push(ctx.session.auth.current?.principalId ?? null);
                  },
                  "turn.settled"(_event, ctx) {
                    turnAuth.push(ctx.session.auth.current?.principalId ?? null);
                  },
                },
              }),
            }),
          },
        ],
      },
    );

    expect(stages.map(turnBoundaries).flat()).toEqual([
      "turn.started turn_0",
      "turn.settled turn_0",
    ]);
    expect(seen.map((entry) => entry.caller)).toEqual(["alice", "alice", "alice"]);
    // Bob's delivery never made him the turn's caller, not even while it was refused.
    expect(new Set(turnAuth)).toEqual(new Set(["alice"]));
    // Bob's stale answer never reached Alice's turn as text.
    expect(JSON.stringify(stages)).not.toContain("staging db");
  }, 60_000);

  it("never credits an approval sent with null auth to the turn's caller", async () => {
    const { secondRequesters, seen, stages } = await withChainRun(
      "approval-caller-null-auth",
      async (run) => {
        // The call has a requester, so an unauthenticated answer settles nothing, with or
        // without a response policy; the requester's own answer still decides it.
        const refusedDirect = await run.approve(null, "deploy_change", "response.settled");
        expect(filterEventsByType(refusedDirect, "interaction.settled")).toEqual([]);
        await run.approve(ALICE, "deploy_change");
        const refused = await run.approve(null, "publish_change", "response.settled");
        expect(filterEventsByType(refused, "interaction.settled")).toEqual([]);
        await run.approve(ALICE, "publish_change");
      },
      { firstApproval: always() },
    );

    expect(seen.map((entry) => entry.caller)).toEqual(["alice", "alice", "alice"]);
    expect(secondRequesters).toEqual(["alice"]);
    // Each approval settles on Alice's answer, the only one a responder sent.
    const events = stages.flat();
    for (const toolName of ["deploy_change", "publish_change"]) {
      const approval = approvalsIn(stages).find((entry) => entry.toolName === toolName);
      const settled = filterEventsByType(events, "interaction.settled").find(
        (event) => event.data.interactionId === approval?.interactionId,
      );
      expect(settled?.data.outcome).toBe("accepted");
      const decider = settled?.data.cause;
      const submitted = filterEventsByType(events, "response.submitted").find(
        (event) =>
          decider !== undefined &&
          "responseId" in decider &&
          event.data.responseId === decider.responseId,
      );
      const admitted = filterEventsByType(events, "delivery.admitted").find(
        (event) => event.data.deliveryId === submitted?.data.deliveryId,
      );
      expect(admitted?.data.principal?.id).toBe("alice");
    }
  }, 60_000);

  it("runs approved calls in parallel as their requester", async () => {
    const { log, seen } = await withChainRun(
      "approval-caller-parallel",
      async (run) => {
        await run.approve(BOB, "deploy_change");
        await run.approve(ALICE, "publish_change");
      },
      { message: "Call in parallel: deploy_change, publish_change." },
    );

    // Both calls were running at once.
    expect(log.slice(0, 2).every((entry) => entry.startsWith("start "))).toBe(true);
    expect(new Map(seen.map((entry) => [entry.tool, entry.caller]))).toEqual(
      new Map([
        ["deploy_change", "alice"],
        ["publish_change", "alice"],
      ]),
    );
  }, 60_000);

  it("keeps requester identity when a later call repeats an approved call id", async () => {
    // Some providers repeat call ids. Turn 1's report_caller is gated and Bob
    // approves it; turn 2 calls it again ungated, with the same id.
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          const last = prompt.at(-1);
          if (last?.role === "tool") return textStreamResult("Done.");
          const again = JSON.stringify(prompt).includes("Run it again");
          return toolCallStreamResult({
            input: JSON.stringify({ gated: !again }),
            toolCallId: "call-repeated",
            toolName: "report_caller",
          });
        },
      }),
    );
    const { stages } = await withChainRun(
      "approval-caller-repeated-id",
      async (run) => {
        await run.approve(BOB, "report_caller");
        await run.send(ALICE, "Run it again, please.");
      },
      {
        message: "Report who runs report_caller.",
        model,
        modules: [
          {
            loadNamespace: async () => ({
              default: defineWorkflowTool({
                approval: {
                  request: ({ toolInput }) =>
                    (toolInput as { gated?: boolean } | undefined)?.gated === true
                      ? "user-approval"
                      : "not-applicable",
                  response: anyoneResponds,
                },
                description: "Report who runs this.",
                execute: reportCallerWorkflow as WorkflowExecuteToolDefinition["execute"],
                inputSchema: {},
              }),
            }),
            logicalPath: "tools/report_caller.ts",
          },
        ],
      },
    );

    // The repeat gets its own id, so turn 1's call keeps its row and both run as Alice.
    expect(outputsOf(stages, "call-repeated")).toEqual([{ caller: "alice" }]);
    expect(outputsOf(stages, "call-repeated_2")).toEqual([{ caller: "alice" }]);
  }, 60_000);
});

const CAROL = testUser("carol");

/**
 * Calls, in order, each tool a request names: every user message that starts with "Use " asks for
 * the tools it names, and a tool named twice runs twice. A tool the model isn't offered directly,
 * such as a connection's, is called through eve__tool. Replies once every call has a result.
 */
function requestModel(prompts: string[] = []) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt, tools }) => {
        prompts.push(JSON.stringify(prompt));
        const offered = new Set((tools ?? []).map((tool) => tool.name));
        const answered = new Set(
          prompt.flatMap((message) =>
            message.role === "tool"
              ? message.content.flatMap((part) =>
                  part.type === "tool-result" ? [part.toolCallId] : [],
                )
              : [],
          ),
        );
        const named = new Map<string, number>();
        for (const message of prompt) {
          if (message.role !== "user") continue;
          for (const part of message.content) {
            if (part.type !== "text" || !part.text.startsWith("Use ")) continue;
            for (const [name] of part.text.matchAll(/\b[a-z]+(?:_{1,2}[a-z]+)+\b/gu)) {
              const count = (named.get(name) ?? 0) + 1;
              named.set(name, count);
              const toolCallId = count === 1 ? `call-${name}` : `call-${name}-${count}`;
              if (answered.has(toolCallId)) continue;
              return offered.has(name)
                ? toolCallStreamResult({ input: "{}", toolCallId, toolName: name })
                : toolCallStreamResult({
                    input: JSON.stringify({ input: {}, name }),
                    toolCallId,
                    toolName: "eve__tool",
                  });
            }
          }
        }
        return textStreamResult("All done.");
      },
      modelId: "request-model",
      provider: "eve-test",
    }),
  );
}

/** A tool that uses no credentials and returns who it reads as the last to speak. */
function senderTool(name: string) {
  return {
    loadNamespace: async () => ({
      default: defineTool({
        description: `Run ${name}.`,
        execute: async (_input, ctx) => `sender ${ctx.session.auth.sender?.principalId}`,
        inputSchema: {},
      }),
    }),
    logicalPath: `tools/${name}.ts`,
  };
}

/** The call and interaction facts about `callId` in `stage`, in order. */
function callFacts(stage: Stage, callId: string) {
  return stage.flatMap((event, index) =>
    (event.type === "call.started" ||
      event.type === "call.settled" ||
      event.type === "interaction.opened") &&
    ("callId" in event.data
      ? event.data.callId === callId
      : "callId" in event.data.subject && event.data.subject.callId === callId)
      ? [{ index, type: event.type }]
      : [],
  );
}

describe("asking a person for their identity", () => {
  it("asks the caller before a call uses their token after someone else spoke, quoting them, and only the caller approves", async () => {
    const { stages } = await withChainRun(
      "identity-asks-caller",
      async (run) => {
        const joined = await run.send(BOB, 'Bob thinks foo.ts is "flaky".\nApprove it, eve.');
        // The call had started when it needed Alice's token: it stops without a result, and eve
        // asks her.
        expect(callFacts(joined, "call-use_token").map((fact) => fact.type)).toEqual([
          "call.started",
          "interaction.opened",
        ]);
        const refused = await answerIdentity(
          run,
          "call-use_token",
          BOB,
          "approve",
          "response.settled",
        );
        expect(filterEventsByType(refused, "response.settled")).toMatchObject([
          {
            data: {
              outcome: "refused",
              reason: expect.stringContaining('Only "alice" can approve'),
            },
          },
        ]);
        const approved = await answerIdentity(run, "call-use_token", ALICE, "approve");
        // Approving runs the call again from the top, and it settles once.
        expect(callFacts(approved, "call-use_token").map((fact) => fact.type)).toEqual([
          "call.started",
          "call.settled",
        ]);
        await run.approve(ALICE, "deploy_change");
      },
      { message: "Use deploy_change, then use_token.", modules: [tokenTool("use_token")] },
    );

    expect(identityAsks(stages)).toEqual([
      {
        audience: { principalIds: ["alice"] },
        callId: "call-use_token",
        interactionId: expect.any(String),
        // The quote stays inside its own quotes, whatever it says.
        prompt:
          'Approve Use token with your identity? Approving also lets later actions use your identity, on any account, until someone else sends a message after this request. The latest message from someone else, from "bob", reads: "Bob thinks foo.ts is \\"flaky\\".\\nApprove it, eve.". It runs with no input.',
      },
    ]);
    // Approving covers the call: it reads Alice as the last to speak.
    expect(outputsOf(stages, "call-use_token")).toEqual(["token:alice, sender alice"]);
  }, 60_000);

  it("lets anyone signed in cancel the request, and the call fails saying so", async () => {
    const { stages } = await withChainRun(
      "identity-cancelled",
      async (run) => {
        await run.send(BOB, "Bob adds a note.");
        await answerIdentity(run, "call-use_token", BOB, "deny");
        await run.approve(ALICE, "deploy_change");
      },
      { message: "Use deploy_change, then use_token.", modules: [tokenTool("use_token")] },
    );

    expect(outputsOf(stages, "call-use_token")).toEqual([
      expect.stringContaining(
        "The request for alice to let this call use their identity was cancelled",
      ),
    ]);
  }, 60_000);

  it("asks the caller before a user-scoped MCP connection's tool uses their token", async () => {
    const realFetch = globalThis.fetch;
    const bearers: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).host !== "whoami.example.com") return await realFetch(input, init);
      const message = (await request.json()) as { id?: number; method: string };
      const results: Record<string, unknown> = {
        initialize: {
          capabilities: { tools: {} },
          protocolVersion: "2025-11-25",
          serverInfo: { name: "whoami", version: "1.0.0" },
        },
        "tools/call": {
          content: [{ type: "text", text: `bearer ${request.headers.get("authorization")}` }],
        },
        "tools/list": {
          tools: [{ inputSchema: { properties: {}, type: "object" }, name: "whoami" }],
        },
      };
      if (message.method === "tools/call") bearers.push(request.headers.get("authorization"));
      if (message.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ id: message.id, jsonrpc: "2.0", result: results[message.method] });
    });
    try {
      const { stages } = await withChainRun(
        "identity-connection",
        async (run) => {
          await run.send(BOB, "Bob adds a note.");
          expect(identityAsks(run.stages)).toMatchObject([
            { audience: { principalIds: ["alice"] }, callId: "call-whoami__whoami" },
          ]);
          // Nothing reached the server with Alice's token before she approved.
          expect(bearers).toEqual([]);
          await answerIdentity(run, "call-whoami__whoami", ALICE, "approve");
          await run.approve(ALICE, "deploy_change");
        },
        {
          message: "Use deploy_change, then whoami__whoami.",
          model: requestModel(),
          modules: [
            {
              loadNamespace: async () => ({
                default: defineMcpClientConnection({
                  auth: CALLER_TOKEN,
                  description: "Says who the request is from.",
                  protocolVersionDiscovery: false,
                  url: "https://whoami.example.com/mcp",
                }),
              }),
              logicalPath: "connections/whoami.ts",
            },
          ],
        },
      );

      expect(bearers).toEqual(["Bearer token:alice"]);
      expect(JSON.stringify(outputsOf(stages, "call-whoami__whoami"))).toContain(
        "bearer Bearer token:alice",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);

  it("asks no more once the caller speaks, and runs a waiting request's call as a task", async () => {
    const prompts: string[] = [];
    const { stages } = await withChainRun(
      "identity-caller-speaks",
      async (run) => {
        await run.send(BOB, "Bob adds a note.");
        // Alice's message joins while use_token's request is open. That call waits as a task, and
        // she spoke last, so the call her message asks for runs without asking.
        await run.send(ALICE, "Use use_token_later.");
        expect(outputsOf(run.stages, "call-use_token_later")).toEqual([
          "token:alice, sender alice",
        ]);
        await answerIdentity(run, "call-use_token", ALICE, "approve");
        await run.approve(ALICE, "deploy_change");
      },
      {
        message: "Use deploy_change, then use_token.",
        model: requestModel(prompts),
        modules: [tokenTool("use_token"), tokenTool("use_token_later")],
      },
    );

    expect(identityAsks(stages).map((ask) => ask.callId)).toEqual(["call-use_token"]);
    // The approved waiting call's result reached the model as its task's result.
    expect(prompts.at(-1)).toMatch(
      /<task_result id=\\"[\w-]+\\" tool=\\"use_token\\" status=\\"completed\\">token:alice/u,
    );
  }, 60_000);

  it("covers the caller's later calls with their approval until someone else speaks again", async () => {
    const { stages } = await withChainRun(
      "identity-until-someone-speaks",
      async (run) => {
        await run.send(BOB, "Bob adds a note.");
        await answerIdentity(run, "call-use_token", ALICE, "approve");
        // use_token_again ran without asking: Alice approved since Bob last spoke. hold_change
        // then waits on its approval, and Bob speaks again.
        await run.send(BOB, "Bob adds another note.");
      },
      {
        message:
          "Use deploy_change, then use_token, then use_token_again, then read_sender, then hold_change, then use_token_later.",
        model: requestModel(),
        modules: [
          tokenTool("use_token"),
          tokenTool("use_token_again"),
          senderTool("read_sender"),
          recordingTool("hold_change", [], [], { request: always(), response: anyoneResponds }),
          tokenTool("use_token_later"),
        ],
      },
    );

    // The approval hands out Alice's token, and every call still reads Bob as the last to speak:
    // role checks keep seeing who asked.
    expect(outputsOf(stages, "call-use_token_again")).toEqual(["token:alice, sender bob"]);
    expect(outputsOf(stages, "call-read_sender")).toEqual(["sender bob"]);
    // Bob's new message ends the approval: the next call asks again.
    expect(identityAsks(stages).map((ask) => ask.callId)).toEqual([
      "call-use_token",
      "call-use_token_later",
    ]);
  }, 60_000);

  it("covers only its own call with an approval asked before someone else spoke again", async () => {
    const { stages } = await withChainRun(
      "identity-stale-approval",
      async (run) => {
        await run.send(BOB, "Bob adds a note.");
        // Bob speaks again while use_token's request is open: the call waits as a task, and
        // hold_change waits on its approval.
        await run.send(BOB, "Bob adds another note.");
        // Alice approves the request Bob's first note led to, which Bob's second note followed.
        await answerIdentity(run, "call-use_token", ALICE, "approve");
        await run.approve(ALICE, "hold_change");
      },
      {
        message: "Use deploy_change, then use_token, then hold_change, then use_token_later.",
        model: requestModel(),
        modules: [
          tokenTool("use_token"),
          recordingTool("hold_change", [], [], { request: always(), response: anyoneResponds }),
          tokenTool("use_token_later"),
        ],
      },
    );

    expect(outputsOf(stages, "call-use_token")).toEqual(["token:alice, sender alice"]);
    expect(identityAsks(stages).map((ask) => ask.callId)).toEqual([
      "call-use_token",
      "call-use_token_later",
    ]);
  }, 60_000);

  it("acts as the person ctx.getToken names with as, asking them unless they spoke last", async () => {
    const { stages } = await withChainRun(
      "identity-as",
      async (run) => {
        await run.send(BOB, "Bob adds a note.");
        // Naming the caller is the same as naming no one: Bob spoke last, so Alice is asked.
        await answerIdentity(run, "call-token_for_alice", ALICE, "approve");
        // token_for_bob ran unasked, Bob having spoken last, and token_for_carol named someone
        // who hasn't spoken. Carol's message asks for Bob's token again.
        await run.send(CAROL, "Use token_for_bob again.");
        const refused = await answerIdentity(
          run,
          "call-token_for_bob-2",
          ALICE,
          "approve",
          "response.settled",
        );
        expect(filterEventsByType(refused, "response.settled")).toMatchObject([
          { data: { outcome: "refused" } },
        ]);
        await answerIdentity(run, "call-token_for_bob-2", BOB, "approve");
      },
      {
        message:
          "Use deploy_change, then token_for_alice, then token_for_bob, then token_for_carol.",
        model: requestModel(),
        modules: [
          tokenTool("token_for_alice", { as: "alice" }),
          tokenTool("token_for_bob", { as: "bob" }),
          tokenTool("token_for_carol", { as: "carol" }),
        ],
      },
    );

    expect(outputsOf(stages, "call-token_for_alice")).toEqual(["token:alice, sender alice"]);
    expect(outputsOf(stages, "call-token_for_bob")).toEqual(["token:bob, sender bob"]);
    expect(outputsOf(stages, "call-token_for_carol")).toEqual([
      expect.stringContaining(
        'No one with the principalId "carol" has spoken in this conversation',
      ),
    ]);
    expect(identityAsks(stages)).toMatchObject([
      { audience: { principalIds: ["alice"] }, callId: "call-token_for_alice" },
      {
        audience: { principalIds: ["bob"] },
        callId: "call-token_for_bob-2",
        prompt: expect.stringContaining('from "carol", reads: "Use token_for_bob again."'),
      },
    ]);
    expect(outputsOf(stages, "call-token_for_bob-2")).toEqual([
      expect.stringMatching(/^token:bob, sender /u),
    ]);
  }, 60_000);
  it.each([
    {
      approval: undefined,
      asked: ["alice", "carol"],
      name: "asks each person a call needs once, keeps both approvals, and runs the call once",
      approve: async (run: ChainRun) => {
        await answerIdentity(run, "call-both_tokens", ALICE, "approve");
        await answerIdentity(run, "call-both_tokens", CAROL, "approve");
      },
    },
    {
      approval: { request: always() },
      asked: ["carol"],
      name: "keeps the caller's approval of the tool when the call then asks another person",
      approve: async (run: ChainRun) => {
        await run.approve(ALICE, "both_tokens");
        await answerIdentity(run, "call-both_tokens", CAROL, "approve");
      },
    },
  ])(
    "$name",
    async ({ approval, approve, asked }) => {
      const { stages } = await withChainRun(
        "identity-two-people",
        async (run) => {
          await run.send(CAROL, "Carol adds a note.");
          // Bob asks for a call that needs Alice's token and Carol's: neither spoke last.
          await run.send(BOB, "Use both_tokens.");
          await approve(run);
        },
        {
          message: "Use deploy_change.",
          model: requestModel(),
          modules: [
            {
              loadNamespace: async () => ({
                default: defineTool({
                  approval,
                  description: "Use Alice's token and Carol's.",
                  execute: async (_input, ctx) => {
                    const { token: caller } = await ctx.getToken(CALLER_TOKEN);
                    const { token: carol } = await ctx.getToken(CALLER_TOKEN, { as: "carol" });
                    return `${caller} ${carol}`;
                  },
                  inputSchema: {},
                }),
              }),
              logicalPath: "tools/both_tokens.ts",
            },
          ],
        },
      );

      expect(identityAsks(stages).map((ask) => ask.audience?.principalIds)).toEqual(
        asked.map((person) => [person]),
      );
      expect(outputsOf(stages, "call-both_tokens")).toEqual(["token:alice token:carol"]);
    },
    60_000,
  );

  it("signs in the person as names, resuming the turn as its caller, without releasing the caller's identity", async () => {
    const connected = new Set<string>();
    const signInAs: ToolAuthProvider = {
      principalType: "user",
      async getToken({ principal }) {
        const id = principal.type === "user" ? principal.id : "app";
        if (!connected.has(id)) throw new ConnectionAuthorizationRequiredError("svc");
        return { token: `signed-in:${id}` };
      },
      async startAuthorization({ callbackUrl }) {
        return { challenge: { url: `https://idp.example/authorize?callback=${callbackUrl}` } };
      },
      async completeAuthorization({ principal }) {
        const id = principal.type === "user" ? principal.id : "app";
        connected.add(id);
        return { token: `signed-in:${id}` };
      },
    };
    const callers: Array<string | undefined> = [];
    const { stages } = await withChainRun(
      "identity-named-sign-in",
      async (run) => {
        // Bob spoke last, so his own token needs no approval, only his sign-in.
        const asked = await run.send(BOB, "Use bob_then_caller.");
        const signIn = filterEventsByType(asked, "interaction.opened").find(
          (event) => event.data.request.kind === "sign-in",
        );
        expect(signIn?.data.audience).toEqual({ principalIds: ["bob"] });
        await run.signIn(signIn!.data.interactionId, "svc");
      },
      {
        message: "Use deploy_change.",
        model: requestModel(),
        modules: [
          {
            loadNamespace: async () => ({
              default: defineTool({
                description: "Use Bob's token, then the caller's.",
                execute: async (_input, ctx) => {
                  callers.push(ctx.session.auth.current?.principalId);
                  const { token: bob } = await ctx.getToken(signInAs, {
                    as: "bob",
                    authKey: "svc",
                  });
                  const { token: caller } = await ctx.getToken(CALLER_TOKEN);
                  return `${bob} ${caller}`;
                },
                inputSchema: {},
              }),
            }),
            logicalPath: "tools/bob_then_caller.ts",
          },
        ],
      },
    );

    // The callback resumed the turn as Alice, its caller, and the call ran again as hers.
    expect(callers).toEqual(["alice", "alice"]);
    expect(connected).toEqual(new Set(["bob"]));
    // Bob's sign-in released nothing of Alice's: the call stopped to ask her.
    expect(identityAsks(stages)).toMatchObject([
      { audience: { principalIds: ["alice"] }, callId: "call-bob_then_caller" },
    ]);
    expect(outputsOf(stages, "call-bob_then_caller")).toEqual([]);
  }, 60_000);

  it("lets a local subagent's tool act for a person who spoke only in the delegating session", async () => {
    const { stages } = await withChainRun(
      "identity-as-in-subagent",
      async (run) => {
        // Bob's message joins Alice's turn, and the model hands his request to a subagent, which
        // reports as a task.
        await run.send(BOB, "Ask a helper to use token_for_bob.");
        for (let read = 0; read < 3 && outputsOf(run.stages, "call-agent").length === 0; read++)
          await run.next("the helper's result");
        await run.approve(ALICE, "deploy_change");
      },
      {
        message: "Use deploy_change.",
        model: delegatingModel(),
        modules: [tokenTool("token_for_bob", { as: "bob" })],
      },
    );

    // The child's tool found Bob, and he spoke last in the turn that delegated to it.
    expect(outputsOf(stages, "call-agent")).toEqual(["child read token:bob, sender bob"]);
  }, 60_000);

  it("carries the caller's approval into a local subagent", async () => {
    const { stages } = await withChainRun(
      "identity-approval-in-subagent",
      async (run) => {
        await run.send(BOB, "Use use_token.\nAsk a helper to use use_token_again.");
        await answerIdentity(run, "call-use_token", ALICE, "approve");
        for (let read = 0; read < 3 && outputsOf(run.stages, "call-agent").length === 0; read++)
          await run.next("the helper's result");
        await run.approve(ALICE, "deploy_change");
      },
      {
        message: "Use deploy_change.",
        model: delegatingModel(),
        modules: [tokenTool("use_token"), tokenTool("use_token_again")],
      },
    );

    // Alice approved after Bob spoke, and no one spoke since, so the child's call used her token
    // without asking.
    expect(identityAsks(stages).map((ask) => ask.callId)).toEqual(["call-use_token"]);
    expect(outputsOf(stages, "call-agent")).toEqual(["child read token:alice, sender bob"]);
  }, 60_000);
});

/**
 * In the parent, calls each tool a "Use " line names, then hands an "Ask a helper to use <tool>"
 * message to the built-in agent tool. The child, which reads only "Use <tool>.", calls the tool
 * and replies with its result.
 */
function delegatingModel() {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const texts = prompt.flatMap((message) =>
          message.role === "user"
            ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            : [],
        );
        const called = new Set(
          prompt.flatMap((message) =>
            message.role === "assistant"
              ? message.content.flatMap((part) =>
                  part.type === "tool-call" ? [part.toolName] : [],
                )
              : [],
          ),
        );
        const results = prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) => (part.type === "tool-result" ? [part] : []))
            : [],
        );
        for (const text of texts) {
          const tool = /^Use (\w+)\.$/mu.exec(text)?.[1];
          if (tool === undefined || called.has(tool)) continue;
          return toolCallStreamResult({ input: "{}", toolCallId: `call-${tool}`, toolName: tool });
        }
        const helped = texts.find((text) => text.includes("Ask a helper to use "));
        if (helped !== undefined && !called.has("agent")) {
          const tool = /Ask a helper to use (\w+)/u.exec(helped)![1]!;
          return toolCallStreamResult({
            input: JSON.stringify({ message: `Use ${tool}.` }),
            toolCallId: "call-agent",
            toolName: "agent",
          });
        }
        const last = results.at(-1);
        if (helped === undefined && last !== undefined && last.toolName !== "deploy_change") {
          const { output } = last;
          const text = output.type === "text" ? output.value : JSON.stringify(output);
          return textStreamResult(`child read ${text}`);
        }
        return textStreamResult("All done.");
      },
      modelId: "delegating-model",
      provider: "eve-test",
    }),
  );
}

describe("steered()", () => {
  it("asks only the caller before a call made after someone else spoke, and their approval covers later calls until someone else speaks", async () => {
    const { stages } = await withChainRun(
      "steered-asks-caller",
      async (run) => {
        const joined = await run.send(BOB, "Bob adds a note.");
        // eve asks before read_sender starts, with its request for Alice's identity.
        expect(callFacts(joined, "call-read_sender").map((fact) => fact.type)).toEqual([
          "interaction.opened",
        ]);
        const refused = await answerIdentity(
          run,
          "call-read_sender",
          BOB,
          "approve",
          "response.settled",
        );
        expect(filterEventsByType(refused, "response.settled")).toMatchObject([
          { data: { outcome: "refused", reason: expect.stringContaining('Only "alice" can') } },
        ]);
        // read_again then runs unasked, and hold_change waits on its own approval when Bob speaks
        // again.
        await answerIdentity(run, "call-read_sender", ALICE, "approve");
        await run.send(BOB, "Bob adds another note.");
      },
      {
        approval: steered(),
        message:
          "Use deploy_change, then read_sender, then read_again, then hold_change, then read_later.",
        model: requestModel(),
        modules: [
          senderTool("read_sender"),
          senderTool("read_again"),
          recordingTool("hold_change", [], [], { request: always(), response: anyoneResponds }),
          senderTool("read_later"),
        ],
      },
    );

    expect(identityAsks(stages)).toMatchObject([
      {
        audience: { principalIds: ["alice"] },
        callId: "call-read_sender",
        prompt:
          'Approve Read sender with your identity? Approving also lets later actions use your identity, on any account, until someone else sends a message after this request. The latest message from someone else, from "bob", reads: "Bob adds a note.". It runs with no input.',
      },
      // Bob's new message ends Alice's approval.
      { callId: "call-read_later" },
    ]);
    // The call Alice approved reads her as the last to speak; one her standing approval covers
    // still reads Bob.
    expect(outputsOf(stages, "call-read_sender")).toEqual(["sender alice"]);
    expect(outputsOf(stages, "call-read_again")).toEqual(["sender bob"]);
  }, 60_000);

  it("denies the call when anyone cancels eve's request, and the call never starts", async () => {
    const { stages } = await withChainRun(
      "steered-cancelled",
      async (run) => {
        await run.send(BOB, "Bob adds a note.");
        await answerIdentity(run, "call-read_sender", BOB, "deny");
        await run.approve(ALICE, "deploy_change");
      },
      {
        approval: steered(),
        message: "Use deploy_change, then read_sender.",
        model: requestModel(),
        modules: [senderTool("read_sender")],
      },
    );

    expect(callFacts(stages.flat(), "call-read_sender").map((fact) => fact.type)).toEqual([
      "interaction.opened",
      "call.settled",
    ]);
    expect(outputsOf(stages, "call-read_sender")).toMatchObject([
      { code: "TOOL_EXECUTION_DENIED", tool: { result: "not_run" } },
    ]);
  }, 60_000);

  it.each([
    {
      approval: steered(),
      approver: ALICE,
      expected: [{ sender: "alice" }],
      name: "asks the caller before it starts, and runs as them once they approve",
    },
    {
      approval: { request: always(), response: anyoneResponds },
      approver: BOB,
      expected: [
        expect.objectContaining({ message: expect.stringContaining("can't run until they") }),
      ],
      name: "denies a call someone else approved when it would start, telling the model why",
    },
  ])(
    "for a workflow tool, $name",
    async ({ approval, approver, expected }) => {
      const { stages } = await withChainRun(
        `steered-workflow-${approver.principalId}`,
        async (run) => {
          await run.send(BOB, "Bob adds a note.");
          if (approver === ALICE) await answerIdentity(run, "call-report_sender", ALICE, "approve");
          else await run.approve(BOB, "report_sender");
          await run.approve(ALICE, "deploy_change");
        },
        {
          approval: steered(),
          message: "Use deploy_change, then report_sender.",
          model: requestModel(),
          modules: [
            {
              loadNamespace: async () => ({
                default: defineWorkflowTool({
                  approval: approval as Approval,
                  description: "Report who runs this.",
                  execute: reportSenderWorkflow as WorkflowExecuteToolDefinition["execute"],
                  inputSchema: {},
                }),
              }),
              logicalPath: "tools/report_sender.ts",
            },
          ],
        },
      );

      expect(outputsOf(stages, "call-report_sender")).toEqual(expected);
    },
    60_000,
  );
});
