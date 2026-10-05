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

const CHAIN = ["deploy_change", "read_notes", "publish_change"] as const;

// Scripted model: call each tool in CHAIN once, in order, then reply.
const scriptedModel = markMockModel(
  new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const done = new Set(
        prompt.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result" ? [part.toolName] : [],
              )
            : [],
        ),
      );
      const next = CHAIN.find((name) => !done.has(name));
      return next === undefined
        ? textStreamResult("All done.")
        : toolCallStreamResult({ input: "{}", toolCallId: `call-${next}`, toolName: next });
    },
    modelId: "repro-model",
    provider: "repro",
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
async function withChainRun(name: string, body: (run: ChainRun) => Promise<void>) {
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
    ],
  });
  const continuationToken = `http:${name}`;
  const stages: Stage[] = [];

  await runtime.run(async () => {
    const run = await start(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Use deploy_change, then read_notes, then publish_change." },
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

describe("approval turn hand-off", () => {
  it("runs work another person approves in that person's own turn", async () => {
    const { secondRequesters, seen, stages } = await withChainRun(
      "approval-hand-off",
      async (run) => {
        await run.approve(BOB);
        await run.approve(ALICE);
      },
    );

    expect(stages.map(turnBoundaries)).toEqual([
      ["turn.started turn_0"],
      ["turn.completed turn_0", "turn.started turn_1"],
      ["turn.completed turn_1", "turn.started turn_2", "turn.completed turn_2"],
    ]);
    expect(seen).toEqual([
      { tool: "deploy_change", caller: "bob" },
      { tool: "read_notes", caller: "bob" },
      { tool: "publish_change", caller: "alice" },
    ]);
    // publish_change was requested in Bob's turn.
    expect(secondRequesters).toEqual(["bob"]);
  }, 60_000);

  it("keeps one turn when the requester approves their own calls", async () => {
    const { secondRequesters, seen, stages } = await withChainRun("approval-self", async (run) => {
      await run.approve(ALICE);
      await run.approve(ALICE);
    });

    expect(stages.map(turnBoundaries)).toEqual([
      ["turn.started turn_0"],
      [],
      ["turn.completed turn_0"],
    ]);
    expect(seen.map((entry) => entry.caller)).toEqual(["alice", "alice", "alice"]);
    expect(secondRequesters).toEqual(["alice"]);
  }, 60_000);

  it("lets the responder, not the requester, steer the turn it took over", async () => {
    const { seen, stages } = await withChainRun("approval-hand-off-steer", async (run) => {
      await run.approve(BOB);
      // Bob's turn now holds on publish_change, so Bob's message steers it.
      const steered = await run.send(BOB, "Never mind, skip publishing.");
      expect(filterEventsByType(steered, "input.resolved")[0]?.data.resolutions).toMatchObject([
        { outcome: "ignored" },
      ]);
    });

    expect(stages.map(turnBoundaries).slice(1)).toEqual([
      ["turn.completed turn_0", "turn.started turn_1"],
      ["turn.completed turn_1"],
    ]);
    expect(seen.map((entry) => entry.tool)).toEqual(["deploy_change", "read_notes"]);
  }, 60_000);
});
