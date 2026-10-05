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

describe("repro: approver identity leaks into the rest of the requester's turn", () => {
  it("runs the approved call and later calls in Alice's turn as Bob", async () => {
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
        name: "approver-caller-repro",
      },
      modules: [
        recordingTool("deploy_change", seen, always()),
        recordingTool("read_notes", seen),
        recordingTool("publish_change", seen, secondApproval),
      ],
    });
    const continuationToken = "http:approver-caller-repro";

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
      try {
        // Alice's turn parks on deploy_change.
        const first = await withTimeout(stream.nextTurn(), "first approval");
        const firstRequest = filterEventsByType(first, "input.requested")[0]?.data.requests[0];
        expect(firstRequest?.kind).toBe("tool-approval");
        const turnId = filterEventsByType(first, "turn.started")[0]?.data.turnId;

        // Bob approves it.
        await resumeHook(commandInbox, {
          auth: BOB,
          kind: "send",
          payload: {
            inputResponses: [{ optionId: "approve", requestId: firstRequest!.requestId }],
          },
        });

        // Same turn continues: read_notes (ungated) runs, then publish_change parks.
        const second = await withTimeout(stream.nextTurn(), "second approval");
        expect(filterEventsByType(second, "turn.started")).toHaveLength(0);
        const secondRequest = filterEventsByType(second, "input.requested")[0]?.data.requests[0];
        expect(secondRequest?.kind).toBe("tool-approval");

        // Alice approves the second call herself.
        await resumeHook(commandInbox, {
          auth: ALICE,
          kind: "send",
          payload: {
            inputResponses: [{ optionId: "approve", requestId: secondRequest!.requestId }],
          },
        });
        const done = await withTimeout(stream.nextTurn(), "turn completion");
        expect(filterEventsByType(done, "turn.completed")[0]?.data.turnId).toBe(turnId);

        console.log("tool callers:", JSON.stringify(seen));
        console.log("publish_change request.principal:", JSON.stringify(secondRequesters));

        // What a one-principal-per-turn model would expect. These fail on main.
        expect({ seen, secondRequesters }).toEqual({
          seen: [
            { tool: "deploy_change", caller: "alice" },
            { tool: "read_notes", caller: "alice" },
            { tool: "publish_change", caller: "alice" },
          ],
          secondRequesters: ["alice"],
        });
      } finally {
        stream.dispose();
        await run.cancel().catch(() => {});
      }
    });
  }, 60_000);
});
