import { jsonSchema } from "ai";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, ToolStubsKey } from "#context/keys.js";
import { toolStubProvider } from "#context/providers/tool-stubs.js";
import { appendTaskContext } from "#execution/tasks/model-step.js";
import { toolCallModelOutput } from "#harness/tool-call-io.js";
import {
  createTask,
  readTaskTable,
  settleTaskCalls,
  writeTaskTable,
} from "#execution/tasks/table.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { describe, expect, it } from "vitest";
import { start } from "#internal/workflow/runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  callToolStubStep,
  readStubFailure,
  readMatchedStubRules,
} from "#execution/tool-stubs/steps.js";
import { STUB_CONTEXT_KEY } from "#tool-stubs/types.js";

describe("durable tool stub playback", () => {
  it("allocates concurrent calls once and reuses an earlier result after later workflow resumes", async () => {
    const runtime = await createTestRuntime({ agent: { name: "stub-playback" } });
    await runtime.run(async () => {
      const rules = [
        {
          id: "list",
          tool: "list_tasks",
          outcomes: [{ throw: { message: "Task service unavailable" } }, { response: ["dog"] }],
        },
      ] as const;
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {},
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: { token: "test-stub-playback", rules },
          },
        },
      ]);
      await waitForHook({ runId: run.runId }, { token: "test-stub-playback" });
      const scope = {
        token: "test-stub-playback",
        rootSessionId: run.runId,
        rules,
      };
      expect(await readMatchedStubRules(run.runId)).toEqual([]);
      const call = { tool: "list_tasks", input: {} };
      const outputs = await Promise.all([
        callToolStubStep(scope, { ...call, callId: "root:first" }),
        callToolStubStep(scope, { ...call, callId: "child:second" }),
      ]);
      expect(
        outputs.map((result) => (result.kind === "stub" ? result.position : null)).sort(),
      ).toEqual([0, 1]);
      expect(await callToolStubStep(scope, { ...call, callId: "root:first" })).toEqual(outputs[0]);
      expect(await callToolStubStep(scope, { ...call, callId: "root:third" })).toEqual({
        kind: "stub",
        ruleId: "list",
        position: 1,
        outcome: { response: ["dog"] },
      });
      expect(await readStubFailure(run.runId)).toBeUndefined();
      expect(await readMatchedStubRules(run.runId)).toEqual(["list"]);
    });
  });
  it.each([
    { stubbed: true, reportingFails: false, recover: true },
    { stubbed: false, reportingFails: false, recover: true },
    { stubbed: true, reportingFails: true, recover: true },
    { stubbed: true, reportingFails: true, recover: false },
  ])(
    "preserves output errors and recovery without passing an unverifiable eval: %j",
    async ({ stubbed, reportingFails, recover }) => {
      const runtime = await createTestRuntime();
      await runtime.run(async () => {
        const rules = [
          {
            id: "task",
            tool: "lookup",
            match: { value: { const: "stubbed" } },
            outcome: { response: "raw" },
          },
        ];
        const token = "delayed-task-projection";
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: {},
            serializedContext: {
              ...buildSerializedContext({ channelKind: "http" }),
              [STUB_CONTEXT_KEY]: { token, rules },
            },
          },
        ]);
        try {
          await waitForHook({ runId: run.runId }, { token });
          const scope = { token, rules, rootSessionId: run.runId };
          await callToolStubStep(scope, {
            callId: `${run.runId}:turn_0:lookup`,
            tool: "lookup",
            input: { value: stubbed ? "stubbed" : "live" },
          });
          const task = createTask(readTaskTable(undefined), {
            callId: "lookup",
            kind: "tool",
            name: "lookup",
            resumable: false,
            turnId: "turn_0",
          });
          const { table } = settleTaskCalls(task.table, {
            taskId: task.taskId,
            callIds: ["lookup"],
            outcome: { status: "completed", output: "raw" },
          });
          // Reload the saved task result before processing its output in the next turn.
          const session = JSON.parse(
            JSON.stringify(
              writeTaskTable(
                createTestSessionState({ sessionId: run.runId }).snapshot.session,
                table,
              ),
            ),
          );
          const context = new ContextContainer();
          context.set(SessionKey, {
            sessionId: run.runId,
            turn: { id: "turn_1", sequence: 1 },
            auth: { current: null, initiator: null },
          });
          await contextStorage.run(context, async () => {
            context.set(
              ToolStubsKey,
              reportingFails ? { ...scope, token: "unavailable-playback" } : scope,
            );
            context.setVirtualContext(
              toolStubProvider.key,
              toolStubProvider.create(context)!.value,
            );
            const outputError = new Error("Invalid output.");
            const definition = {
              name: "lookup",
              description: "Lookup",
              inputSchema: jsonSchema({ type: "object" }),
              toModelOutput: () => {
                throw outputError;
              },
            };
            if (!recover) {
              await expect(toolCallModelOutput(definition, "raw", "lookup")).rejects.toBe(
                outputError,
              );
              return;
            }
            const delivered = await appendTaskContext({
              session,
              messages: [],
              tools: new Map([["lookup", definition]]),
            });
            expect(JSON.stringify(delivered.messages)).toContain("raw");
            expect(readTaskTable(delivered.session.state).tasks[0]?.results).toEqual([]);
          });
          if (reportingFails) {
            expect(await run.status).toBe("cancelled");
            expect(await readStubFailure(run.runId)).toBe(
              "Tool stub session failed before verification.",
            );
          } else {
            expect(await readStubFailure(run.runId)).toBe(
              stubbed ? 'Stubbed tool "lookup" failed during output processing.' : undefined,
            );
          }
        } finally {
          if ((await run.status) !== "cancelled") await run.cancel();
        }
      });
    },
  );
});
