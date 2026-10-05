import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic } from "#dynamic/definition.js";
import type { Approval } from "#approval/definition.js";
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

// Scripted model: calls each tool the first message names, in the order it
// names them, once each, then replies.
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

/** Records `ctx.session.auth.current` for every tool that runs. */
function recordingTool(
  name: string,
  seen: Array<{ tool: string; caller: string | null }>,
  approval?: Approval,
) {
  return {
    loadNamespace: async () => ({
      default: defineTool({
        approval,
        description: `Run ${name}.`,
        execute: (_input, ctx) => {
          seen.push({ tool: name, caller: ctx.session.auth.current?.principalId ?? null });
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
  readonly approve: (approver: User) => Promise<Stage>;
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
    readonly message?: string;
    readonly modules?: NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"];
  } = {},
) {
  const seen: Array<{ tool: string; caller: string | null }> = [];
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
            "step.started": () => ({ model: scriptedModel, modelContextWindowTokens: 200_000 }),
          },
        }),
      }),
      name,
    },
    modules: [
      recordingTool("deploy_change", seen, always()),
      recordingTool("read_notes", seen),
      recordingTool("publish_change", seen, secondApproval),
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
        stages,
        async approve(approver) {
          const request = filterEventsByType(stages.at(-1)!, "input.requested")[0]?.data
            .requests[0];
          expect(request?.kind).toBe("tool-approval");
          await resumeHook(commandInbox, {
            auth: approver,
            kind: "send",
            payload: { inputResponses: [{ optionId: "approve", requestId: request!.requestId }] },
          });
          return await next("approved");
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
  return { secondRequesters, seen, stages };
}

function turnBoundaries(stage: Stage) {
  return stage
    .filter((event) => event.type === "turn.started" || event.type === "turn.completed")
    .map((event) => `${event.type} ${(event.data as { turnId: string }).turnId}`);
}

describe("approval caller", () => {
  it("runs only the call another person approves as that person", async () => {
    const { secondRequesters, seen, stages } = await withChainRun(
      "approval-caller",
      async (run) => {
        await run.approve(BOB);
        await run.approve(ALICE);
      },
    );

    // Bob's approval resumes Alice's turn; it does not start his own.
    expect(stages.map(turnBoundaries)).toEqual([
      ["turn.started turn_0"],
      [],
      ["turn.completed turn_0"],
    ]);
    expect(seen).toEqual([
      { tool: "deploy_change", caller: "bob" },
      { tool: "read_notes", caller: "alice" },
      { tool: "publish_change", caller: "alice" },
    ]);
    expect(secondRequesters).toEqual(["alice"]);
  }, 60_000);

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
      { tool: "deploy_change", caller: "bob" },
      { tool: "read_notes", caller: "alice" },
    ]);
  }, 60_000);

  it("starts an approved workflow tool's run as its approver", async () => {
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
                approval: always(),
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
      caller: "bob",
    });
  }, 60_000);
});
