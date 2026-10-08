import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { markMockModel } from "#internal/mock-model-identity.js";
import {
  textStreamResult,
  toolCallStreamResult,
  toolCallsStreamResult,
} from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic } from "#dynamic/definition.js";
import type { Approval, ApprovalResponsePolicy } from "#approval/definition.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import {
  type WorkflowExecuteToolDefinition,
  defineWorkflowTool,
} from "#tools/workflow-definition.js";
import { reportCallerWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
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

/** Records `ctx.session.auth.current` for every tool that runs. */
function recordingTool(
  name: string,
  seen: Array<{ tool: string; caller: string | null }>,
  log: string[],
  approval?: Approval,
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
          log.push(`end ${name}`);
          return { ran: name };
        },
        inputSchema: {},
      }),
    }),
    logicalPath: `tools/${name}.ts`,
  };
}

type User = ReturnType<typeof testUser>;
type Stage = Awaited<ReturnType<ReturnType<typeof captureTurnEvents>["nextTurn"]>>;

interface ChainRun {
  /** Approves the pending request for `toolName`, or the first one. */
  readonly approve: (approver: User | null, toolName?: string) => Promise<Stage>;
  /** Reads the session's next turn segment. */
  readonly next: (label: string) => Promise<Stage>;
  /** Sends `payload` as one delivery on the session's command inbox. */
  readonly deliver: (auth: User, payload: Record<string, unknown>) => Promise<Stage>;
  readonly send: (auth: User, message: string) => Promise<Stage>;
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
    readonly firstApproval?: Approval;
    readonly message?: string;
    readonly stubs?: readonly ToolStub[];
    readonly model?: MockLanguageModelV4;
    readonly modules?: NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"];
  } = {},
) {
  const seen: Array<{ tool: string; caller: string | null }> = [];
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
        model: defineDynamic({
          events: {
            "step.started": () => ({
              model: options.model ?? scriptedModel,
              modelContextWindowTokens: 200_000,
            }),
          },
        }),
      }),
      name,
    },
    modules: [
      recordingTool(
        "deploy_change",
        seen,
        log,
        options.firstApproval ?? { request: always(), response: anyoneResponds },
      ),
      recordingTool("read_notes", seen, log),
      recordingTool("publish_change", seen, log, secondApproval),
      ...(options.modules ?? []),
    ],
  });
  const continuationToken = `http:${name}`;
  const stages: Stage[] = [];

  await runtime.run(async () => {
    const run = await start(workflowEntry, [
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
        async approve(approver, toolName) {
          const request = stages
            .flatMap((stage) => filterEventsByType(stage, "input.requested"))
            .flatMap((event) => event.data.requests)
            .filter((entry) => toolName === undefined || entry.action.toolName === toolName)
            .at(toolName === undefined ? -1 : 0);
          expect(request?.kind).toBe("tool-approval");
          await resumeHook(commandInbox, {
            auth: approver,
            kind: "send",
            payload: { inputResponses: [{ optionId: "approve", requestId: request!.requestId }] },
          });
          return await next("approved");
        },
        async deliver(auth, payload) {
          await resumeHook(commandInbox, { auth, kind: "send", payload });
          return await next("delivered");
        },
        async send(auth, message) {
          await resumeHook(sessionInboxHookToken(continuationToken), {
            auth,
            kind: "send",
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
  return { log, secondRequesters, seen, stages };
}

function turnBoundaries(stage: Stage) {
  return stage
    .filter((event) => event.type === "turn.started" || event.type === "turn.completed")
    .map((event) => `${event.type} ${(event.data as { turnId: string }).turnId}`);
}

describe("approval caller", () => {
  it.each([false, true])(
    "runs a call another person approves as its requester (unmatched stub: %s)",
    async (withStub) => {
      const { secondRequesters, seen, stages } = await withChainRun(
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
        ["turn.completed turn_0"],
      ]);
      expect(seen).toEqual([
        { tool: "deploy_change", caller: "alice" },
        { tool: "read_notes", caller: "alice" },
        { tool: "publish_change", caller: "alice" },
      ]);
      expect(secondRequesters).toEqual(["alice"]);
    },
    60_000,
  );

  it("lets the requester steer the turn after someone else approves a call", async () => {
    const { seen, stages } = await withChainRun("approval-caller-steer", async (run) => {
      await run.approve(BOB);
      // The turn is still Alice's, so her message steers past publish_change.
      const steered = await run.send(ALICE, "Never mind, skip publishing.");
      expect(filterEventsByType(steered, "input.resolved")[0]?.data.resolutions).toMatchObject([
        { outcome: "ignored" },
      ]);
    });

    expect(stages.map(turnBoundaries)).toEqual([
      ["turn.started turn_0"],
      [],
      ["turn.completed turn_0"],
    ]);
    expect(seen).toEqual([
      { tool: "deploy_change", caller: "alice" },
      { tool: "read_notes", caller: "alice" },
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
        modules: [
          {
            loadNamespace: async () => ({
              default: defineWorkflowTool({
                approval: { request: always(), response: anyoneResponds },
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

    const results = stages
      .flat()
      .flatMap((event) => (event.type === "action.result" ? [event.data.result] : []));
    expect(results.find((result) => result.callId === "call-report_caller")?.output).toEqual({
      caller: "alice",
    });
  }, 60_000);

  it("keeps the rest of another person's delivery out of the turn their answer resumes", async () => {
    const { seen, secondRequesters, stages } = await withChainRun(
      "approval-caller-mixed",
      async (run) => {
        const request = filterEventsByType(run.stages[0]!, "input.requested")[0]!.data.requests[0]!;
        await run.deliver(BOB, {
          inputResponses: [{ optionId: "approve", requestId: request.requestId }],
          message: "Bob here: also delete the staging database.",
        });
        await run.approve(ALICE);
        // Bob's message waited for Alice's turn to end, then started his own.
        await run.next("Bob's turn");
      },
    );

    expect(seen).toEqual([
      { tool: "deploy_change", caller: "alice" },
      { tool: "read_notes", caller: "alice" },
      { tool: "publish_change", caller: "alice" },
    ]);
    expect(secondRequesters).toEqual(["alice"]);
    const received = stages.flatMap((stage) => filterEventsByType(stage, "message.received"));
    expect(received.map((event) => event.data.turnId)).toEqual(["turn_0", "turn_1"]);
  }, 60_000);

  it("never credits an approval sent with null auth to the turn's caller", async () => {
    const { secondRequesters, seen, stages } = await withChainRun(
      "approval-caller-null-auth",
      async (run) => {
        // Without a response policy, the approval stands; the call runs as the turn's caller.
        await run.approve(null, "deploy_change");
        // A response policy needs an authenticated responder, so this one stays pending.
        const refused = await run.approve(null, "publish_change");
        expect(filterEventsByType(refused, "input.resolved")).toEqual([]);
        await run.approve(ALICE, "publish_change");
      },
      { firstApproval: always() },
    );

    expect(seen.map((entry) => entry.caller)).toEqual(["alice", "alice", "alice"]);
    expect(secondRequesters).toEqual(["alice"]);
    expect(stages.flatMap((stage) => filterEventsByType(stage, "approval.settled"))).toMatchObject([
      { data: { outcome: "approved", responderPrincipalId: "alice" } },
    ]);
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

    const callers = stages
      .flat()
      .flatMap((event) =>
        event.type === "action.result" && event.data.result.callId === "call-repeated"
          ? [(event.data.result.output as { caller: string }).caller]
          : [],
      );
    expect(callers).toEqual(["alice", "alice"]);
  }, 60_000);
});
