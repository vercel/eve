import { beforeEach, describe, expect, it, vi } from "vitest";

import { isWorkflowTargetGone } from "#execution/tools/workflow/target-gone.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { TaskRecord } from "#tasks/record.js";
import { readPendingTaskResults } from "#tasks/results.js";
import { applyWorkflowSend } from "#tasks/send.js";
import { getTaskTable } from "#tasks/state.js";
import { MAX_UNREAD_SENDS } from "#tasks/table.js";

vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resumeHook: vi.fn(),
}));
vi.mock("#execution/tools/workflow/target-gone.js", () => ({ isWorkflowTargetGone: vi.fn() }));

const NOW = "2026-09-24T14:05:00.000Z";
const RUN = { commandToken: "cmd", kind: "workflow", runId: "run-1" } as const;
const idle = createTaskRecord({
  callId: "call-0",
  child: RUN,
  delivered: true,
  id: "release_notes-abc234",
  kind: "workflow",
  mode: "detached",
  name: "release_notes",
  resumable: true,
  status: "completed",
  turnId: "turn-0",
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function send(records: readonly TaskRecord[], callId = "call-1") {
  return applyWorkflowSend({
    call: { callId, stepIndex: 0, turn: { id: "turn-1", sequence: 1 } },
    caller: null,
    ctx: undefined,
    now: NOW,
    request: {
      callId,
      input: { request: "shorter" },
      taskId: idle.id,
      toolName: "release_notes",
    } as never,
    session: { sessionId: "parent", state: taskTableState(records) },
  });
}

describe("applyWorkflowSend", () => {
  it("never reuses the number of a send whose delivery failed, and keeps its call", async () => {
    vi.mocked(resumeHook).mockRejectedValueOnce(new Error("socket hang up"));

    const failed = await send([idle]);

    expect(failed.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: {
          code: "TASK_UNREACHABLE",
          message: `Task "${idle.id}" is temporarily unreachable. Try again.`,
        },
      }),
    ]);
    // The task stays idle; the run may still have the send, so its call is kept.
    const [record] = getTaskTable(failed.session).records;
    expect(record).toMatchObject({
      generation: 1,
      lastSeq: 1,
      status: "completed",
      undelivered: [{ callId: "call-1", seq: 1, turnId: "turn-1" }],
    });

    const retried = await send([record!], "call-2");
    expect(vi.mocked(resumeHook)).toHaveBeenLastCalledWith(
      "cmd",
      expect.objectContaining({ kind: "input", seq: 2 }),
    );
    expect(getTaskTable(retried.session).records[0]).toMatchObject({
      callId: "call-2",
      generation: 2,
      startedBy: 2,
    });
  });

  it("ends an idle task whose run is gone, so later sends fail UNKNOWN_TASK", async () => {
    vi.mocked(resumeHook).mockRejectedValueOnce(new Error("hook not found"));
    vi.mocked(isWorkflowTargetGone).mockReturnValue(true);

    const failed = await send([idle]);

    expect(failed.results).toEqual([
      expect.objectContaining({
        output: expect.objectContaining({
          code: "TASK_UNREACHABLE",
          message: expect.stringContaining("its workflow run ended"),
        }),
      }),
    ]);
    expect(getTaskTable(failed.session).records).toEqual([]);
    const later = await send(getTaskTable(failed.session).records, "call-2");
    expect(later.results).toEqual([
      expect.objectContaining({ output: expect.objectContaining({ code: "UNKNOWN_TASK" }) }),
    ]);
  });

  it("fails a working generation and holds its result when the run is gone", async () => {
    vi.mocked(resumeHook).mockRejectedValueOnce(new Error("hook not found"));
    vi.mocked(isWorkflowTargetGone).mockReturnValue(true);
    const working = { ...idle, delivered: false, status: "working" as const };

    const failed = await send([working]);

    expect(failed.events.map((event) => event.type)).toEqual(["task.settled"]);
    expect(getTaskTable(failed.session).records).toEqual([
      expect.objectContaining({ ended: true, status: "failed" }),
    ]);
    expect(readPendingTaskResults(failed.session.state)).toEqual([
      expect.objectContaining({
        generation: 1,
        outcome: expect.objectContaining({ status: "failed" }),
        taskId: idle.id,
      }),
    ]);
  });

  it("refuses a send past the unread cap without delivering it", async () => {
    const sends = Array.from({ length: MAX_UNREAD_SENDS }, (_, index) => ({
      callId: `queued-${String(index)}`,
      seq: index + 1,
      turnId: "turn-1",
    }));
    const busy = {
      ...idle,
      delivered: false,
      lastSeq: MAX_UNREAD_SENDS,
      sends,
      status: "working" as const,
    };

    const refused = await send([busy]);

    expect(refused.results).toEqual([
      expect.objectContaining({ output: expect.objectContaining({ code: "TASK_BUSY" }) }),
    ]);
    expect(resumeHook).not.toHaveBeenCalled();
    expect(getTaskTable(refused.session).records[0]?.sends).toHaveLength(MAX_UNREAD_SENDS);
  });
});
