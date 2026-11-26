import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { TASK_SYSTEM_BLOCK } from "#execution/tasks/render.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { createTestInProcessRuntime } from "#internal/testing/in-process-runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createStreamChecker, type Violation } from "#protocol/session-events/checker.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";
import { schemaViolation } from "#protocol/session-events/schemas.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import { toolOutput } from "#tools/model-output.js";
import { canPromoteToTask, promoteToTask } from "#tools/task-handoff.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

const PROMOTED_WORKFLOW_ID = "workflow//test//promotedLongJob";

async function collectViolations(runtime: Runtime, sessionId: string): Promise<Violation[]> {
  const checker = createStreamChecker({ validate: schemaViolation });
  const found: Violation[] = [];
  let position = 0;
  for await (const record of await runtime.getLineStream(sessionId, { follow: false })) {
    if (!isStoredLine(record)) throw new Error(`Line ${position} isn't a stored line.`);
    found.push(...checker.check(record, position++));
  }
  return found;
}

async function runPromotionScenario(
  input: {
    readonly defaultTools?: false;
    readonly model: MockLanguageModelV4;
    readonly name: string;
    readonly tools: Readonly<Record<string, unknown>>;
    readonly workflow: (
      handoff: { readonly job: string },
      ctx: WorkflowToolContext,
    ) => Promise<unknown>;
  },
  body: (ctx: {
    readonly channel: ReturnType<typeof createChannelAddress>;
    readonly runtime: Runtime;
  }) => Promise<void>,
): Promise<void> {
  const app = await createTestRuntime({
    agent: {
      definition: defineAgent({
        ...(input.defaultTools === false && { defaultTools: false }),
        model: defineDynamic(() => ({ model: input.model, modelContextWindowTokens: 200_000 })),
      }),
      name: input.name,
    },
    modules: Object.entries(input.tools).map(([toolName, tool]) => ({
      loadNamespace: async () => ({ default: tool }),
      logicalPath: `tools/${toolName}.ts`,
    })),
  });
  await app.run(async () => {
    const runtime = createTestInProcessRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    runtime.registerWorkflow(PROMOTED_WORKFLOW_ID, input.workflow);
    try {
      const channel = createChannelAddress({
        adapter: { kind: "http" },
        channelName: "http",
        continuationToken: `http:${input.name}`,
        runtime,
      });
      await body({ channel, runtime });
    } finally {
      await runtime.dispose();
    }
  });
}

describe("inline tool task promotion and deferred task guidance", () => {
  it("announces task guidance without mutating system, skips toModelOutput on receipts, renders error-text cleanly, and latches task tools on tool-only agents", async () => {
    const observedTools: string[][] = [];
    const observedSystems: string[] = [];
    const observedPrompts: string[] = [];
    const modelOutputInputs: unknown[] = [];
    let finishDeferred!: (value: { readonly exitCode: number; readonly summary: string }) => void;
    const deferredReady = new Promise<{ readonly exitCode: number; readonly summary: string }>(
      (resolve) => {
        finishDeferred = resolve;
      },
    );

    let step = 0;
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async (options) => {
          observedTools.push((options.tools ?? []).map((tool) => tool.name));
          observedSystems.push(
            options.prompt
              .filter((message) => message.role === "system")
              .map((message) => (typeof message.content === "string" ? message.content : ""))
              .join("\n"),
          );
          const promptJson = JSON.stringify(options.prompt);
          observedPrompts.push(promptJson);
          step += 1;
          if (step === 1) {
            return toolCallsStreamResult([
              { input: '{"mode":"fast"}', toolCallId: "call_fast", toolName: "run_job" },
            ]);
          }
          if (step === 2) {
            return toolCallsStreamResult([
              { input: '{"mode":"slow"}', toolCallId: "call_slow", toolName: "run_job" },
            ]);
          }
          if (step === 3) {
            setTimeout(() => finishDeferred({ exitCode: 1, summary: "2 tests failed" }), 10);
            return toolCallsStreamResult([
              { input: "{}", toolCallId: "call_wait", toolName: TASK_WAIT_TOOL_NAME },
            ]);
          }
          if (step === 4) {
            expect(promptJson).toContain("JOB_OUTPUT: 2 tests failed\\n[exit code: 1]");
            expect(promptJson).not.toContain('\\"type\\":\\"error-text\\"');
            return textStreamResult("First turn done.");
          }
          return textStreamResult("Second turn done.");
        },
        modelId: "task-promotion-complete",
        provider: "eve-test",
      }),
    );

    let cancelCalled = false;
    const runJobTool = defineTool({
      description: "Runs a job inline or promotes it to a durable task.",
      inputSchema: z.object({ mode: z.enum(["fast", "slow"]) }),
      async execute(input) {
        if (input.mode === "fast") return { exitCode: 0, summary: "instant ok" };
        expect(canPromoteToTask()).toBe(true);
        return promoteToTask<{ readonly exitCode: number; readonly summary: string }>({
          handoff: { job: "build-42" },
          onCancel: () => {
            cancelCalled = true;
          },
          preview: "Compiling crate...",
          workflowId: PROMOTED_WORKFLOW_ID,
        });
      },
      toModelOutput(output) {
        modelOutputInputs.push(output);
        const text = `JOB_OUTPUT: ${output.summary}`;
        return output.exitCode !== 0
          ? toolOutput.errorText(`${text}\n[exit code: ${output.exitCode}]`)
          : toolOutput.text(text);
      },
    });

    await runPromotionScenario(
      {
        defaultTools: false,
        model,
        name: "task-promotion-complete",
        tools: { run_job: runJobTool },
        workflow: async (handoff) => {
          expect(handoff).toEqual({ job: "build-42" });
          return await deferredReady;
        },
      },
      async ({ channel, runtime }) => {
        const turn1 = await channel.send("Run the jobs.", { auth: null });
        expect(await turn1.result()).toMatchObject({
          reply: "First turn done.",
          status: "completed",
        });

        const turn2 = await channel.send("Follow up.", { auth: null });
        expect(await turn2.result()).toMatchObject({
          reply: "Second turn done.",
          status: "completed",
        });

        expect(modelOutputInputs).toEqual([
          { exitCode: 0, summary: "instant ok" },
          { exitCode: 1, summary: "2 tests failed" },
        ]);
        expect(observedSystems.every((system) => !system.includes(TASK_SYSTEM_BLOCK))).toBe(true);
        expect(new Set(observedSystems).size).toBe(1);
        expect(observedPrompts[0]).not.toContain("A call that returns");
        expect(observedPrompts[1]).not.toContain("A call that returns");
        expect(observedPrompts[2]).toContain("A call that returns");

        expect(observedTools[0]).not.toContain(TASK_WAIT_TOOL_NAME);
        expect(observedTools[0]).not.toContain(TASK_CANCEL_TOOL_NAME);
        expect(observedTools[1]).not.toContain(TASK_WAIT_TOOL_NAME);
        expect(observedTools[2]).toContain(TASK_WAIT_TOOL_NAME);
        expect(observedTools[2]).toContain(TASK_CANCEL_TOOL_NAME);
        expect(observedTools[4]).toContain(TASK_WAIT_TOOL_NAME);
        expect(observedTools[4]).toContain(TASK_CANCEL_TOOL_NAME);

        expect(cancelCalled).toBe(false);
        expect(await collectViolations(runtime, turn1.sessionId)).toEqual([]);
      },
    );
  });

  it("promotes an inline tool call that required human approval", async () => {
    let finishDeferred!: (value: { readonly summary: string }) => void;
    const deferredReady = new Promise<{ readonly summary: string }>((resolve) => {
      finishDeferred = resolve;
    });

    let step = 0;
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async (options) => {
          step += 1;
          if (step === 1) {
            return toolCallsStreamResult([
              { input: "{}", toolCallId: "call_approved_slow", toolName: "approved_job" },
            ]);
          }
          if (step === 2) {
            setTimeout(() => finishDeferred({ summary: "approved build done" }), 10);
            return toolCallsStreamResult([
              { input: "{}", toolCallId: "call_wait", toolName: TASK_WAIT_TOOL_NAME },
            ]);
          }
          expect(JSON.stringify(options.prompt)).toContain("APPROVED_OUTPUT: approved build done");
          return textStreamResult("Approved job completed.");
        },
        modelId: "task-promotion-approved",
        provider: "eve-test",
      }),
    );

    const approvedJobTool = defineTool({
      approval: always(),
      description: "Requires approval and promotes to a durable task.",
      inputSchema: z.object({}),
      async execute() {
        expect(canPromoteToTask()).toBe(true);
        return promoteToTask<{ readonly summary: string }>({
          handoff: { job: "approved-1" },
          preview: "Approved job running...",
          workflowId: PROMOTED_WORKFLOW_ID,
        });
      },
      toModelOutput(output) {
        return toolOutput.text(`APPROVED_OUTPUT: ${output.summary}`);
      },
    });

    await runPromotionScenario(
      {
        model,
        name: "task-promotion-approved",
        tools: { approved_job: approvedJobTool },
        workflow: async (handoff) => {
          expect(handoff).toEqual({ job: "approved-1" });
          return await deferredReady;
        },
      },
      async ({ channel, runtime }) => {
        const turn = await channel.send("Run the approved job.", { auth: null });
        const paused = await turn.result();
        expect(paused.status).toBe("awaiting-input");
        const approvalId = paused.interactions[0]?.interactionId;
        expect(approvalId).toBeDefined();

        const resumed = await channel.respond(
          [{ interactionId: approvalId!, optionId: "approve" }],
          { auth: null },
        );
        expect(await resumed.result()).toMatchObject({
          reply: "Approved job completed.",
          status: "completed",
        });
        expect(await collectViolations(runtime, turn.sessionId)).toEqual([]);
      },
    );
  });

  it("aborts a promoted task workflow and runs cleanup when cancelled via task_cancel", async () => {
    let cleanedUp = false;
    let startedResolve!: () => void;
    const workflowStarted = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    let step = 0;
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async (options) => {
          step += 1;
          if (step === 1) {
            return toolCallsStreamResult([
              { input: '{"mode":"slow"}', toolCallId: "call_hang", toolName: "run_job" },
            ]);
          }
          if (step === 2) {
            await workflowStarted;
            const taskMatch = /Started task (\S+?)\./.exec(JSON.stringify(options.prompt));
            expect(taskMatch?.[1]).toBeDefined();
            return toolCallsStreamResult([
              {
                input: JSON.stringify({ taskId: taskMatch![1] }),
                toolCallId: "call_cancel",
                toolName: TASK_CANCEL_TOOL_NAME,
              },
            ]);
          }
          return textStreamResult("Cancelled the hung job.");
        },
        modelId: "task-promotion-cancel",
        provider: "eve-test",
      }),
    );

    const runJobTool = defineTool({
      description: "Runs a job inline or promotes it to a durable task.",
      inputSchema: z.object({ mode: z.enum(["slow"]) }),
      async execute() {
        return promoteToTask<{ readonly summary: string }>({
          handoff: { job: "hung-1" },
          preview: "Still running...",
          workflowId: PROMOTED_WORKFLOW_ID,
        });
      },
    });

    await runPromotionScenario(
      {
        model,
        name: "task-promotion-cancel",
        tools: { run_job: runJobTool },
        workflow: async (_handoff, ctx) => {
          startedResolve();
          await new Promise<void>((resolve) => {
            if (ctx.abortSignal.aborted) {
              cleanedUp = true;
              resolve();
              return;
            }
            ctx.abortSignal.addEventListener(
              "abort",
              () => {
                cleanedUp = true;
                resolve();
              },
              { once: true },
            );
          });
          return { summary: "cancelled" };
        },
      },
      async ({ channel, runtime }) => {
        const turn = await channel.send("Start and cancel.", { auth: null });
        expect(await turn.result()).toMatchObject({
          reply: "Cancelled the hung job.",
          status: "completed",
        });
        expect(cleanedUp).toBe(true);
        expect(await collectViolations(runtime, turn.sessionId)).toEqual([]);
      },
    );
  });

  it("runs onCancel cleanup when a turn is cancelled while a sibling inline call is still running", async () => {
    let orphanCleanedUp = false;
    let siblingStartedResolve!: () => void;
    const siblingStarted = new Promise<void>((resolve) => {
      siblingStartedResolve = resolve;
    });

    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async () =>
          toolCallsStreamResult([
            { input: "{}", toolCallId: "call_promo", toolName: "promo_job" },
            { input: "{}", toolCallId: "call_sibling", toolName: "slow_sibling" },
          ]),
        modelId: "task-promotion-abort",
        provider: "eve-test",
      }),
    );

    const promoJobTool = defineTool({
      description: "Promotes immediately with an onCancel cleanup hook.",
      inputSchema: z.object({}),
      async execute() {
        return promoteToTask<{ readonly ok: boolean }>({
          handoff: { job: "orphan-1" },
          onCancel: () => {
            orphanCleanedUp = true;
          },
          preview: "Promoted before sibling finished.",
          workflowId: PROMOTED_WORKFLOW_ID,
        });
      },
    });

    const slowSiblingTool = defineTool({
      description: "Waits until aborted.",
      inputSchema: z.object({}),
      async execute(_input, ctx) {
        siblingStartedResolve();
        await new Promise<void>((_resolve, reject) => {
          ctx.abortSignal.addEventListener("abort", () => reject(ctx.abortSignal.reason), {
            once: true,
          });
        });
        return { ok: true };
      },
    });

    await runPromotionScenario(
      {
        model,
        name: "task-promotion-abort",
        tools: { promo_job: promoJobTool, slow_sibling: slowSiblingTool },
        workflow: async () => ({ ok: true }),
      },
      async ({ channel }) => {
        const turn = await channel.send("Run both.", { auth: null });
        await siblingStarted;
        await channel.cancel({ auth: null });
        await turn.result();
        expect(orphanCleanedUp).toBe(true);
      },
    );
  });
});
