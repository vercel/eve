import { describe, expect, it } from "vitest";

import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { workflowToolRunWorkflowReference } from "#execution/workflow-runtime.js";
import {
  resumableCancelWorkflow,
  resumableEdgesWorkflow,
  resumableNotesWorkflow,
  resumableOwnerProbeWorkflow,
} from "#internal/testing/resumable-workflow-fixtures.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { readWorkflowFunctionId } from "#internal/workflow/reference.js";
import { getRun, resumeHook, start } from "#internal/workflow/runtime.js";

// Drives a resumable workflow tool run through its command hook against the
// local Workflow world, with a probe workflow standing in for the owner
// session's inbox. Every hook resume replays the run from its log, so the
// body's generation state is rebuilt each time.

type Recorded = { readonly kind: string; readonly [key: string]: unknown };

function recorded(token: string): Recorded[] {
  const store = (globalThis as { __resumableRuns?: Record<string, Recorded[]> }).__resumableRuns;
  return store?.[token] ?? [];
}

async function until<T>(read: () => T | undefined, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the run's messages");
}

const summarize = (messages: readonly Recorded[]) =>
  messages.map((message) => {
    const from = message.from as { readonly callId: string; readonly generation: number };
    switch (message.kind) {
      case "started":
        return `started g${String(from.generation)} send ${String(message.send)} (${from.callId})`;
      case "reply": {
        const result = message.result as { status: string; output?: unknown };
        const read = (message.read as number[]).length > 0 ? ` read ${String(message.read)}` : "";
        return `reply g${String(from.generation)} ${result.status}${
          result.output === undefined ? "" : ` ${JSON.stringify(result.output)}`
        }${read}`;
      }
      case "ended":
        return `ended unread [${String(message.unread)}]`;
      default:
        return message.kind;
    }
  });

async function startResumable(
  name: string,
  execute: (...args: never[]) => unknown,
  input: Record<string, string>,
) {
  const inbox = `resumable:owner:${name}:${Date.now()}`;
  const probe = await start(resumableOwnerProbeWorkflow, [{ token: inbox }]);
  await waitForHook(probe, { token: inbox });
  const hookToken = `resumable:command:${name}:${Date.now()}`;
  const runInput: WorkflowToolRunInput = {
    callId: "call-start",
    hookToken,
    input,
    owner: { inbox },
    resumable: true,
    session: {
      auth: { current: null, initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    stepIndex: 0,
    taskId: `${name}-abc234`,
    toolName: name,
    workflowId: readWorkflowFunctionId(execute)!,
  };
  const run = await start(workflowToolRunWorkflowReference, [runInput]);
  await waitForHook(run, { token: hookToken });
  const send = (seq: number, request: string) =>
    resumeHook(hookToken, {
      call: {
        callId: `call-send-${String(seq)}`,
        stepIndex: 0,
        turn: { id: `turn-${String(seq + 1)}`, sequence: seq },
      },
      input: { request },
      kind: "input",
      seq,
    });
  const wait = (count: number) =>
    until(() => (recorded(inbox).length >= count ? summarize(recorded(inbox)) : undefined));
  return { hookToken, inbox, run, send, wait };
}

describe("a resumable workflow tool run", () => {
  it("settles one generation per reply, each in its send's call, and stays alive between sends", async () => {
    const task = await startResumable("release_notes", resumableNotesWorkflow, {
      request: "0.67",
    });
    expect(await task.wait(1)).toEqual(['reply g1 completed "notes(0.67) @call-start"']);

    await task.send(1, "shorter");
    expect(await task.wait(3)).toEqual([
      'reply g1 completed "notes(0.67) @call-start"',
      "started g2 send 1 (call-send-1)",
      'reply g2 completed "notes(0.67)>shorter @call-send-1"',
    ]);
    // A repeated send, such as a retried owner step, is dropped by its number.
    await task.send(1, "shorter");
    await task.send(2, "close");
    expect(await task.wait(6)).toEqual([
      'reply g1 completed "notes(0.67) @call-start"',
      "started g2 send 1 (call-send-1)",
      'reply g2 completed "notes(0.67)>shorter @call-send-1"',
      "started g3 send 2 (call-send-2)",
      'reply g3 completed "closed after notes(0.67)>shorter @call-send-2"',
      "ended unread []",
    ]);
    expect(await getRun(task.run.runId).status).toBe("completed");
  });

  it("joins a send read before the reply, refuses a second reply, and lists the sends never read", async () => {
    const gate = `resumable:gate:${Date.now()}`;
    const gate2 = `resumable:gate2:${Date.now()}`;
    const task = await startResumable("edges", resumableEdgesWorkflow, {
      gate,
      gate2,
      request: "v1",
    });
    await waitForHook(task.run, { token: gate });
    // Queued before the body reads: the body's first receive returns it.
    await task.send(1, "fix typo");
    await resumeHook(gate, undefined);
    expect(await task.wait(1)).toEqual(['reply g1 completed "draft v1 + fix typo" read 1']);

    await task.send(2, "next");
    const afterSecond = await task.wait(3);
    expect(afterSecond[1]).toBe("started g2 send 2 (call-send-2)");
    expect(afterSecond[2]).toContain(
      'reply g2 completed {"next":"next","secondReply":"ctx.reply()',
    );
    expect(afterSecond[2]).toContain("was already called for generation 1");

    await waitForHook(task.run, { token: gate2 });
    await task.send(3, "never read");
    await resumeHook(gate2, undefined);
    expect(await task.wait(4)).toEqual([...afterSecond, "ended unread [3]"]);
  });

  it("cancels one generation without ending the task, then ends it", async () => {
    const task = await startResumable("browser", resumableCancelWorkflow, { request: "open" });
    await resumeHook(task.hookToken, { kind: "cancel", reason: "Stopped by the model." });
    expect(await task.wait(1)).toEqual(["reply g1 cancelled"]);

    await task.send(1, "click");
    expect(await task.wait(3)).toEqual([
      "reply g1 cancelled",
      "started g2 send 1 (call-send-1)",
      'reply g2 completed "working on click"',
    ]);

    await resumeHook(task.hookToken, { end: true, kind: "cancel", reason: "Session ended." });
    expect(await task.wait(4)).toEqual([
      "reply g1 cancelled",
      "started g2 send 1 (call-send-1)",
      'reply g2 completed "working on click"',
      "ended unread []",
    ]);
    expect(await getRun(task.run.runId).status).toBe("completed");
  });
});
