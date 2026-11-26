import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineDynamic } from "#dynamic/definition.js";
import { routedRunLive } from "#execution/hosts.js";
import { readSessionEventHistory } from "#execution/session-event-stream.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext, captureEvents } from "#internal/testing/entry-test-helpers.js";
import { filterEventsByType } from "#internal/testing/events.js";
import {
  startTestSession,
  type TestSessionHostKind,
} from "#internal/testing/test-session-hosts.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineTool } from "#tools/definition.js";

vi.setConfig({ testTimeout: 60_000 });

const ALICE = {
  attributes: {},
  authenticator: "test-idp",
  issuer: "test-idp",
  principalId: "alice",
  principalType: "user" as const,
};

const isTurnSettled = (event: SessionStreamEvent): boolean => event.type === "turn.settled";

function extractTaskId(raw: string, after?: string): string | undefined {
  const slice = after === undefined ? raw : raw.slice(Math.max(0, raw.lastIndexOf(after)));
  return slice.match(/agent-[a-z0-9]+/u)?.[0];
}

describe.each<TestSessionHostKind>(["in-process", "workflow"])(
  "direct local subagent (%s)",
  (host) => {
    it("reproduces agent-correction-local: correction joins running child turn and settles both calls", async () => {
      const measureDelay = 400;
      const model = markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const userTexts = prompt
              .filter((m) => m.role === "user")
              .map((m) => JSON.stringify(m.content))
              .join("\n");
            const raw = JSON.stringify(prompt);

            if (userTexts.includes("MEASURE_PIER")) {
              if (!raw.includes('"toolName":"slow_measure"') && !raw.includes("measured_ok")) {
                return toolCallsStreamResult([
                  { input: "{}", toolCallId: "child_measure_1", toolName: "slow_measure" },
                ]);
              }
              const corrected = userTexts.includes("CORRECT_SOUTH_PIER");
              return textStreamResult(corrected ? "SOUTH_PIER_4.2M" : "NORTH_PIER_3.1M");
            }

            if (!raw.includes("notebook-measure")) {
              return toolCallsStreamResult([
                {
                  input: JSON.stringify({ message: "MEASURE_PIER north pier" }),
                  toolCallId: "notebook-measure",
                  toolName: "agent",
                },
              ]);
            }
            if (!raw.includes("notebook-correction")) {
              const taskId = extractTaskId(raw);
              return toolCallsStreamResult([
                {
                  input: JSON.stringify({ message: "CORRECT_SOUTH_PIER south pier", taskId }),
                  toolCallId: "notebook-correction",
                  toolName: "agent",
                },
              ]);
            }
            if (!raw.includes("SOUTH_PIER_4.2M") && !raw.includes("NORTH_PIER_3.1M")) {
              return toolCallsStreamResult([
                { input: "{}", toolCallId: "notebook-correction-wait", toolName: "eve__task_wait" },
              ]);
            }
            return textStreamResult(
              raw.includes("SOUTH_PIER_4.2M") ? "REPLY SOUTH_PIER_4.2M" : "REPLY WRONG",
            );
          },
          modelId: "scripted",
          provider: "eve-test",
        }),
      );

      const runtime = await createTestRuntime({
        agent: {
          definition: defineAgent({
            model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
          }),
          name: `direct-correction-${host}`,
        },
        modules: [
          {
            logicalPath: "tools/slow_measure.ts",
            loadNamespace: async () => ({
              default: defineTool({
                description: "Measure slowly.",
                execute: async () => {
                  await new Promise((r) => setTimeout(r, measureDelay));
                  return { status: "measured_ok" };
                },
                inputSchema: z.object({}),
              }),
            }),
          },
        ],
      });

      await runtime.run(async () => {
        const run = await startTestSession(host, {
          input: { message: "Correct the pier measurement." },
          kind: "initial",
          ownerDeploymentId: "dpl_direct",
          serializedContext: buildSerializedContext({
            auth: ALICE,
            channelKind: "http",
            continuationToken: `http:direct-correction-${host}`,
          }),
        });
        const stream = captureEvents(run);
        try {
          const events = await stream.nextUntil("parent turn", isTurnSettled);
          const settled = filterEventsByType(events, "call.settled");
          expect(settled).toContainEqual(
            expect.objectContaining({
              data: expect.objectContaining({
                callId: "notebook-measure",
                outcome: "completed",
                output: "SOUTH_PIER_4.2M",
              }),
            }),
          );
          expect(settled).toContainEqual(
            expect.objectContaining({
              data: expect.objectContaining({
                callId: "notebook-correction",
                outcome: "completed",
                outputOf: { callId: "notebook-measure" },
              }),
            }),
          );

          const opened = filterEventsByType(events, "child.opened")[0];
          expect(opened).toBeDefined();
          const childEvents: SessionStreamEvent[] = [];
          const reader = readSessionEventHistory(opened!.data.sessionId).getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              childEvents.push(next.value);
              if (next.value.type === "turn.settled") break;
            }
          } finally {
            reader.releaseLock();
          }
          expect(
            childEvents.some(
              (event) =>
                event.type === "delivery.consumed" &&
                event.data.parts.some(
                  (part) => part.kind === "text" && part.text.includes("CORRECT_SOUTH_PIER"),
                ),
            ),
          ).toBe(true);
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    });

    it("reproduces agent-continuation-local: idle recall, cancel, and replacement child", async () => {
      const model = markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const userTexts = prompt
              .filter((m) => m.role === "user")
              .map((m) => JSON.stringify(m.content))
              .join("\n");
            const lastUser = prompt.findLast((m) => m.role === "user");
            const lastText = JSON.stringify(lastUser?.content ?? "");
            const raw = JSON.stringify(prompt);

            if (lastText.includes("CHILD_REMEMBER")) return textStreamResult("SAVED");
            if (lastText.includes("CHILD_RECALL")) {
              return textStreamResult(
                userTexts.includes("CHILD_REMEMBER") ? "NAME=DELTA" : "UNKNOWN",
              );
            }
            if (lastText.includes("CHILD_REVIEW")) {
              if (!raw.includes("slow_review_done")) {
                return toolCallsStreamResult([
                  { input: "{}", toolCallId: "child_review_1", toolName: "slow_review" },
                ]);
              }
              return textStreamResult("REVIEWED");
            }

            if (userTexts.includes("TURN_3_CANCEL")) {
              const taskId = extractTaskId(raw);
              if (!raw.includes("nb-review")) {
                return toolCallsStreamResult([
                  {
                    input: JSON.stringify({ message: "CHILD_REVIEW", taskId }),
                    toolCallId: "nb-review",
                    toolName: "agent",
                  },
                ]);
              }
              if (!raw.includes("nb-cancel")) {
                return toolCallsStreamResult([
                  {
                    input: JSON.stringify({ taskId }),
                    toolCallId: "nb-cancel",
                    toolName: "eve__task_cancel",
                  },
                ]);
              }
              return textStreamResult("DONE_3");
            }

            if (userTexts.includes("TURN_2_CHECK")) {
              const taskId = extractTaskId(raw);
              if (!raw.includes("nb-check")) {
                return toolCallsStreamResult([
                  {
                    input: JSON.stringify({ message: "CHILD_RECALL", taskId }),
                    toolCallId: "nb-check",
                    toolName: "agent",
                  },
                ]);
              }
              if (!raw.includes("NAME=DELTA")) {
                return toolCallsStreamResult([
                  { input: "{}", toolCallId: "nb-check-wait", toolName: "eve__task_wait" },
                ]);
              }
              return textStreamResult("DONE_2");
            }

            if (userTexts.includes("TURN_1_REMEMBER")) {
              if (!raw.includes("nb-remember")) {
                return toolCallsStreamResult([
                  {
                    input: JSON.stringify({ message: "CHILD_REMEMBER DELTA" }),
                    toolCallId: "nb-remember",
                    toolName: "agent",
                  },
                ]);
              }
              if (!raw.includes("SAVED")) {
                return toolCallsStreamResult([
                  { input: "{}", toolCallId: "nb-remember-wait", toolName: "eve__task_wait" },
                ]);
              }
              return textStreamResult("DONE_1");
            }

            return textStreamResult("FALLBACK");
          },
          modelId: "scripted",
          provider: "eve-test",
        }),
      );

      const runtime = await createTestRuntime({
        agent: {
          definition: defineAgent({
            model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
          }),
          name: `direct-continuation-${host}`,
        },
        modules: [
          {
            logicalPath: "tools/slow_review.ts",
            loadNamespace: async () => ({
              default: defineTool({
                description: "Review slowly.",
                execute: async (_input, ctx) => {
                  await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 10_000);
                    ctx.abortSignal?.addEventListener("abort", () => {
                      clearTimeout(timer);
                      resolve(undefined);
                    });
                  });
                  return { status: "slow_review_done" };
                },
                inputSchema: z.object({}),
              }),
            }),
          },
        ],
      });

      await runtime.run(async () => {
        const run = await startTestSession(host, {
          input: { message: "TURN_1_REMEMBER" },
          kind: "initial",
          ownerDeploymentId: "dpl_direct",
          serializedContext: buildSerializedContext({
            auth: ALICE,
            channelKind: "http",
            continuationToken: `http:direct-continuation-${host}`,
          }),
        });
        const stream = captureEvents(run);
        try {
          const t1 = await stream.nextUntil("turn 1", isTurnSettled);
          expect(filterEventsByType(t1, "turn.settled").map((e) => e.data.outcome)).toEqual([
            "completed",
          ]);

          await run.runtime.dispatchSession({
            command: { auth: ALICE, kind: "send", payload: { message: "TURN_2_CHECK" } },
            sessionId: run.runId,
          });
          const t2 = await stream.nextUntil("turn 2", isTurnSettled);
          expect(filterEventsByType(t2, "call.settled")).toContainEqual(
            expect.objectContaining({
              data: expect.objectContaining({
                callId: "nb-check",
                outcome: "completed",
                output: "NAME=DELTA",
              }),
            }),
          );

          await run.runtime.dispatchSession({
            command: { auth: ALICE, kind: "send", payload: { message: "TURN_3_CANCEL" } },
            sessionId: run.runId,
          });
          const t3 = await stream.nextUntil("turn 3", isTurnSettled);
          expect(filterEventsByType(t3, "task.ended")).toContainEqual(
            expect.objectContaining({ data: expect.objectContaining({ outcome: "cancelled" }) }),
          );
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    });

    it("ends the task cleanly when a parked direct child resets or ends without crashing the parent", async () => {
      const model = markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const userTexts = prompt
              .filter((m) => m.role === "user")
              .map((m) => JSON.stringify(m.content))
              .join("\n");
            const raw = JSON.stringify(prompt);

            if (userTexts.includes("CHILD_HELLO")) return textStreamResult("CHILD_OK");

            if (userTexts.includes("SEND_AFTER_END")) {
              const taskId = extractTaskId(raw);
              if (!raw.includes("send-dead")) {
                return toolCallsStreamResult([
                  {
                    input: JSON.stringify({ message: "CHILD_HELLO again", taskId }),
                    toolCallId: "send-dead",
                    toolName: "agent",
                  },
                ]);
              }
              return textStreamResult("RECOVERED_WITHOUT_CRASH");
            }

            if (!raw.includes("start-child")) {
              return toolCallsStreamResult([
                {
                  input: JSON.stringify({ message: "CHILD_HELLO" }),
                  toolCallId: "start-child",
                  toolName: "agent",
                },
              ]);
            }
            if (!raw.includes("CHILD_OK")) {
              return toolCallsStreamResult([
                { input: "{}", toolCallId: "wait-child", toolName: "eve__task_wait" },
              ]);
            }
            return textStreamResult("STARTED_OK");
          },
          modelId: "scripted",
          provider: "eve-test",
        }),
      );

      const runtime = await createTestRuntime({
        agent: {
          definition: defineAgent({
            model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
          }),
          name: `direct-ended-child-${host}`,
        },
      });

      await runtime.run(async () => {
        const run = await startTestSession(host, {
          input: { message: "Start child." },
          kind: "initial",
          ownerDeploymentId: "dpl_direct",
          serializedContext: buildSerializedContext({
            auth: ALICE,
            channelKind: "http",
            continuationToken: `http:direct-ended-child-${host}`,
          }),
        });
        const stream = captureEvents(run);
        try {
          const t1 = await stream.nextUntil("turn 1", isTurnSettled);
          const child = filterEventsByType(t1, "child.opened")[0];
          expect(child).toBeDefined();

          await run.runtime.dispatchSession({
            command: { deliveryId: "reset-1", kind: "reset", reason: "test-end" },
            sessionId: child!.data.sessionId,
          });
          await vi.waitFor(
            async () => {
              expect(await isChildSessionEnded(child!.data.sessionId)).toBe(true);
              const parentSoFar = await readAllChildEvents(run.runId);
              expect(
                filterEventsByType(parentSoFar, "task.ended").some(
                  (event) => event.data.outcome === "cancelled",
                ),
              ).toBe(true);
            },
            { timeout: 10_000 },
          );

          await run.runtime.dispatchSession({
            command: { auth: ALICE, kind: "send", payload: { message: "SEND_AFTER_END" } },
            sessionId: run.runId,
          });
          const t2 = await stream.nextUntil("turn 2", isTurnSettled);
          expect(filterEventsByType(t2, "turn.settled").map((e) => e.data.outcome)).toEqual([
            "completed",
          ]);
          expect(filterEventsByType(t2, "content.completed").map((e) => e.data.value)).toContain(
            "RECOVERED_WITHOUT_CRASH",
          );
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    });

    it("reports cumulative usage across turns when a direct child is cancelled on its second turn", async () => {
      const model = markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const userTexts = prompt
              .filter((m) => m.role === "user")
              .map((m) => JSON.stringify(m.content))
              .join("\n");
            const raw = JSON.stringify(prompt);

            if (userTexts.includes("CHILD_USAGE_2")) {
              if (!raw.includes("quick_done")) {
                return {
                  stream: new ReadableStream({
                    start(controller) {
                      controller.enqueue({
                        input: "{}",
                        toolCallId: "quick_1",
                        toolName: "quick_step",
                        type: "tool-call",
                      });
                      controller.enqueue({
                        finishReason: { raw: "tool-calls", unified: "tool-calls" },
                        type: "finish",
                        usage: {
                          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 100, total: 100 },
                          outputTokens: { reasoning: 0, text: 20, total: 20 },
                        },
                      });
                      controller.close();
                    },
                  }),
                };
              }
              return toolCallsStreamResult([
                { input: "{}", toolCallId: "wait_cancel_1", toolName: "wait_for_cancel" },
              ]);
            }
            if (userTexts.includes("CHILD_USAGE_1")) {
              return {
                stream: new ReadableStream({
                  start(controller) {
                    controller.enqueue({ id: "t", type: "text-start" });
                    controller.enqueue({ delta: "TURN1_OK", id: "t", type: "text-delta" });
                    controller.enqueue({ id: "t", type: "text-end" });
                    controller.enqueue({
                      finishReason: { raw: "stop", unified: "stop" },
                      type: "finish",
                      usage: {
                        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 100, total: 100 },
                        outputTokens: { reasoning: 0, text: 20, total: 20 },
                      },
                    });
                    controller.close();
                  },
                }),
              };
            }

            if (userTexts.includes("USAGE_TURN_2")) {
              const taskId = extractTaskId(raw);
              if (!raw.includes("u-call-2")) {
                return toolCallsStreamResult([
                  {
                    input: JSON.stringify({ message: "CHILD_USAGE_2", taskId }),
                    toolCallId: "u-call-2",
                    toolName: "agent",
                  },
                ]);
              }
              if (!raw.includes("u-wait-2")) {
                return toolCallsStreamResult([
                  {
                    input: JSON.stringify({ timeoutSeconds: 1 }),
                    toolCallId: "u-wait-2",
                    toolName: "eve__task_wait",
                  },
                ]);
              }
              if (!raw.includes("u-cancel-2")) {
                return toolCallsStreamResult([
                  {
                    input: JSON.stringify({ taskId }),
                    toolCallId: "u-cancel-2",
                    toolName: "eve__task_cancel",
                  },
                ]);
              }
              return textStreamResult("USAGE_DONE");
            }

            if (!raw.includes("u-call-1")) {
              return toolCallsStreamResult([
                {
                  input: JSON.stringify({ message: "CHILD_USAGE_1" }),
                  toolCallId: "u-call-1",
                  toolName: "agent",
                },
              ]);
            }
            if (!raw.includes("TURN1_OK")) {
              return toolCallsStreamResult([
                { input: "{}", toolCallId: "u-wait-1", toolName: "eve__task_wait" },
              ]);
            }
            return textStreamResult("USAGE_1_DONE");
          },
          modelId: "scripted",
          provider: "eve-test",
        }),
      );

      const runtime = await createTestRuntime({
        agent: {
          definition: defineAgent({
            model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
          }),
          name: `direct-usage-${host}`,
        },
        modules: [
          {
            logicalPath: "tools/quick_step.ts",
            loadNamespace: async () => ({
              default: defineTool({
                description: "Finishes quickly.",
                execute: async () => ({ status: "quick_done" }),
                inputSchema: z.object({}),
              }),
            }),
          },
          {
            logicalPath: "tools/wait_for_cancel.ts",
            loadNamespace: async () => ({
              default: defineTool({
                description: "Waits until cancelled.",
                execute: async (_input, ctx) => {
                  await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 10_000);
                    ctx.abortSignal?.addEventListener("abort", () => {
                      clearTimeout(timer);
                      resolve(undefined);
                    });
                  });
                  return { ok: true };
                },
                inputSchema: z.object({}),
              }),
            }),
          },
        ],
      });

      await runtime.run(async () => {
        const run = await startTestSession(host, {
          input: { message: "USAGE_TURN_1" },
          kind: "initial",
          ownerDeploymentId: "dpl_direct",
          serializedContext: buildSerializedContext({
            auth: ALICE,
            channelKind: "http",
            continuationToken: `http:direct-usage-${host}`,
          }),
        });
        const stream = captureEvents(run);
        try {
          const t1 = await stream.nextUntil("turn 1", isTurnSettled);
          await run.runtime.dispatchSession({
            command: { auth: ALICE, kind: "send", payload: { message: "USAGE_TURN_2" } },
            sessionId: run.runId,
          });
          await stream.nextUntil("turn 2", isTurnSettled);
          void t1;
          await vi.waitFor(
            async () => {
              const allParent = await readAllChildEvents(run.runId);
              const delegatedInputTokens = filterEventsByType(allParent, "usage.recorded")
                .filter(
                  (event) =>
                    event.data.kind === "delegated-late" ||
                    (event.data.kind === "model" &&
                      event.data.owner !== undefined &&
                      "callId" in event.data.owner),
                )
                .reduce((sum, event) => sum + (event.data.usage?.inputTokens ?? 0), 0);
              expect(delegatedInputTokens).toBe(200);
            },
            { timeout: 10_000 },
          );
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    });

    it("ends the child session when a direct child turn fails and handles empty follow-up messages without crashing the parent", async () => {
      let failChild = false;
      const model = markMockModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const userTexts = prompt
              .filter((m) => m.role === "user")
              .map((m) => JSON.stringify(m.content))
              .join("\n");
            const raw = JSON.stringify(prompt);

            if (userTexts.includes("CHILD_FAIL")) {
              failChild = true;
              throw new Error("child model crashed");
            }
            if (userTexts.includes("CHILD_OK_EMPTY")) return textStreamResult("READY");

            if (userTexts.includes("EMPTY_FOLLOWUP")) {
              const taskId = extractTaskId(raw, "empty-start");
              if (!raw.includes("empty-start")) {
                return toolCallsStreamResult([
                  {
                    input: JSON.stringify({ message: "CHILD_OK_EMPTY" }),
                    toolCallId: "empty-start",
                    toolName: "agent",
                  },
                ]);
              }
              if (!raw.includes("READY")) {
                return toolCallsStreamResult([
                  { input: "{}", toolCallId: "empty-wait", toolName: "eve__task_wait" },
                ]);
              }
              if (!raw.includes("empty-send")) {
                return toolCallsStreamResult([
                  {
                    input: JSON.stringify({ message: "   ", taskId }),
                    toolCallId: "empty-send",
                    toolName: "agent",
                  },
                ]);
              }
              return textStreamResult("EMPTY_HANDLED");
            }

            if (!raw.includes("fail-start")) {
              return toolCallsStreamResult([
                {
                  input: JSON.stringify({ message: "CHILD_FAIL" }),
                  toolCallId: "fail-start",
                  toolName: "agent",
                },
              ]);
            }
            if (!raw.includes("fail-wait")) {
              return toolCallsStreamResult([
                { input: "{}", toolCallId: "fail-wait", toolName: "eve__task_wait" },
              ]);
            }
            return textStreamResult("FAILED_CHILD_HANDLED");
          },
          modelId: "scripted",
          provider: "eve-test",
        }),
      );

      const runtime = await createTestRuntime({
        agent: {
          definition: defineAgent({
            model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
          }),
          name: `direct-fail-empty-${host}`,
        },
      });

      await runtime.run(async () => {
        const run = await startTestSession(host, {
          input: { message: "Run failing child." },
          kind: "initial",
          ownerDeploymentId: "dpl_direct",
          serializedContext: buildSerializedContext({
            auth: ALICE,
            channelKind: "http",
            continuationToken: `http:direct-fail-empty-${host}`,
          }),
        });
        const stream = captureEvents(run);
        try {
          const t1 = await stream.nextUntil("turn 1", isTurnSettled);
          expect(failChild).toBe(true);
          expect(filterEventsByType(t1, "task.ended")).toContainEqual(
            expect.objectContaining({ data: expect.objectContaining({ outcome: "failed" }) }),
          );
          const failedChild = filterEventsByType(t1, "child.opened")[0];
          expect(failedChild).toBeDefined();
          await vi.waitFor(
            async () => {
              expect(await isChildSessionEnded(failedChild!.data.sessionId)).toBe(true);
            },
            { timeout: 10_000 },
          );

          await run.runtime.dispatchSession({
            command: { auth: ALICE, kind: "send", payload: { message: "EMPTY_FOLLOWUP" } },
            sessionId: run.runId,
          });
          const t2 = await stream.nextUntil("turn 2", isTurnSettled);
          expect(filterEventsByType(t2, "turn.settled").map((e) => e.data.outcome)).toEqual([
            "completed",
          ]);
          expect(filterEventsByType(t2, "content.completed").map((e) => e.data.value)).toContain(
            "EMPTY_HANDLED",
          );
          expect(filterEventsByType(t2, "task.ended")).toContainEqual(
            expect.objectContaining({ data: expect.objectContaining({ outcome: "failed" }) }),
          );
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    });
  },
);

async function isChildSessionEnded(sessionId: string): Promise<boolean> {
  if (!(await routedRunLive(sessionId))) return true;
  try {
    const events = await readAllChildEvents(sessionId);
    return events.some((event) => event.type === "session.ended");
  } catch {
    return !(await routedRunLive(sessionId));
  }
}

async function readAllChildEvents(sessionId: string): Promise<SessionStreamEvent[]> {
  const events: SessionStreamEvent[] = [];
  const reader = readSessionEventHistory(sessionId).getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      events.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}
