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

describe("inline tool task promotion and deferred task controls", () => {
  it("omits task controls on fast inline calls, promotes slow calls to durable tasks, delivers projected results, and latches task controls on monotonically", async () => {
    const observedTools: string[][] = [];
    const observedSystems: string[] = [];
    let finishDeferred!: (value: { readonly summary: string }) => void;
    const deferredReady = new Promise<{ readonly summary: string }>((resolve) => {
      finishDeferred = resolve;
    });

    let step = 0;
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async (options) => {
          const toolNames = (options.tools ?? []).map((tool) => tool.name);
          const systemText = options.prompt
            .filter((message) => message.role === "system")
            .map((message) => (typeof message.content === "string" ? message.content : ""))
            .join("\n");
          observedTools.push(toolNames);
          observedSystems.push(systemText);
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
            setTimeout(() => finishDeferred({ summary: "build succeeded: 42 tests" }), 10);
            return toolCallsStreamResult([
              { input: "{}", toolCallId: "call_wait", toolName: TASK_WAIT_TOOL_NAME },
            ]);
          }
          if (step === 4) {
            const promptJson = JSON.stringify(options.prompt);
            expect(promptJson).toContain("JOB_OUTPUT: build succeeded: 42 tests");
            return textStreamResult("First turn done.");
          }
          return textStreamResult("Second turn done.");
        },
        modelId: "task-promotion-complete",
        provider: "eve-test",
      }),
    );

    const runJobTool = defineTool({
      description: "Runs a job inline or promotes it to a durable task.",
      inputSchema: z.object({ mode: z.enum(["fast", "slow"]) }),
      async execute(input) {
        if (input.mode === "fast") return { summary: "instant ok" };
        expect(canPromoteToTask()).toBe(true);
        return promoteToTask<{ readonly summary: string }>({
          handoff: { job: "build-42" },
          preview: "Compiling crate...",
          workflowId: PROMOTED_WORKFLOW_ID,
        });
      },
      toModelOutput(output) {
        if (typeof output === "string") return toolOutput.text(output);
        return toolOutput.text(`JOB_OUTPUT: ${output.summary}`);
      },
    });

    const app = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "task-promotion-complete",
      },
      modules: [
        { loadNamespace: async () => ({ default: runJobTool }), logicalPath: "tools/run_job.ts" },
      ],
    });

    await app.run(async () => {
      const runtime = createTestInProcessRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      runtime.registerWorkflow(PROMOTED_WORKFLOW_ID, async (handoff: { job: string }) => {
        expect(handoff).toEqual({ job: "build-42" });
        return await deferredReady;
      });
      try {
        const channel = createChannelAddress({
          adapter: { kind: "http" },
          channelName: "http",
          continuationToken: "http:promo-complete",
          runtime,
        });
        const turn1 = await channel.send("Run the jobs.", { auth: null });
        const res1 = await turn1.result();
        expect(res1.status).toBe("completed");
        expect(res1.reply).toBe("First turn done.");

        const turn2 = await channel.send("Follow up.", { auth: null });
        const res2 = await turn2.result();
        expect(res2.status).toBe("completed");
        expect(res2.reply).toBe("Second turn done.");

        expect(observedTools[0]).not.toContain(TASK_WAIT_TOOL_NAME);
        expect(observedTools[0]).not.toContain(TASK_CANCEL_TOOL_NAME);
        expect(observedSystems[0]).not.toContain(TASK_SYSTEM_BLOCK);

        expect(observedTools[1]).not.toContain(TASK_WAIT_TOOL_NAME);
        expect(observedSystems[1]).not.toContain(TASK_SYSTEM_BLOCK);

        expect(observedTools[2]).toContain(TASK_WAIT_TOOL_NAME);
        expect(observedTools[2]).toContain(TASK_CANCEL_TOOL_NAME);
        expect(observedSystems[2]).toContain(TASK_SYSTEM_BLOCK);

        expect(observedTools[4]).toContain(TASK_WAIT_TOOL_NAME);
        expect(observedTools[4]).toContain(TASK_CANCEL_TOOL_NAME);
        expect(observedSystems[4]).toContain(TASK_SYSTEM_BLOCK);

        expect(await collectViolations(runtime, turn1.sessionId)).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    });
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
            const receiptText = JSON.stringify(options.prompt);
            const taskMatch = /Started task (\S+?)\./.exec(receiptText);
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

    const app = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "task-promotion-cancel",
      },
      modules: [
        { loadNamespace: async () => ({ default: runJobTool }), logicalPath: "tools/run_job.ts" },
      ],
    });

    await app.run(async () => {
      const runtime = createTestInProcessRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      runtime.registerWorkflow(
        PROMOTED_WORKFLOW_ID,
        async (_handoff: { job: string }, ctx: WorkflowToolContext) => {
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
      );
      try {
        const channel = createChannelAddress({
          adapter: { kind: "http" },
          channelName: "http",
          continuationToken: "http:promo-cancel",
          runtime,
        });
        const turn = await channel.send("Start and cancel.", { auth: null });
        const res = await turn.result();
        expect(res.status).toBe("completed");
        expect(res.reply).toBe("Cancelled the hung job.");
        expect(cleanedUp).toBe(true);
        expect(await collectViolations(runtime, turn.sessionId)).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    });
  });
});
