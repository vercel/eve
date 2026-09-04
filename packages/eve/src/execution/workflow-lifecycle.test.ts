import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readWorkflowOwnership,
  readWorkflowStreamUntil,
  waitForWorkflowCleanup,
  WorkflowStreamTimeoutError,
} from "#execution/workflow-lifecycle.js";

const { getRun, getReadable } = vi.hoisted(() => ({ getRun: vi.fn(), getReadable: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({ getRun }));

beforeEach(() => {
  vi.useFakeTimers();
  getRun.mockReturnValue({ getReadable });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("workflow lifecycle signals", () => {
  it("receives the owning run once, even when it differs from the started candidate", async () => {
    let stream!: ReadableStreamDefaultController<{ runId: string }>;
    const cancel = vi.fn();
    getReadable.mockReturnValue(
      new ReadableStream({
        start(controller) {
          stream = controller;
        },
        cancel,
      }),
    );
    const ownership = readWorkflowOwnership("candidate-run");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getRun).toHaveBeenCalledOnce();
    expect(getReadable).toHaveBeenCalledOnce();
    stream.enqueue({ runId: "winning-run" });
    await expect(ownership).resolves.toEqual({ runId: "winning-run" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails when a candidate exits before acknowledging ownership", async () => {
    getReadable.mockReturnValue(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    );
    await expect(readWorkflowOwnership("candidate-run")).rejects.toThrow(
      /closed before acknowledging ownership/,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the explicit cleanup acknowledgement without rechecking the run", async () => {
    let stream!: ReadableStreamDefaultController<unknown>;
    getReadable.mockReturnValue(
      new ReadableStream({
        start(controller) {
          stream = controller;
        },
      }),
    );
    let completed = false;
    const completion = waitForWorkflowCleanup("session-run").then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(completed).toBe(false);
    expect(getReadable).toHaveBeenCalledOnce();

    stream.enqueue({ released: true });
    await completion;
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not mistake stream closure for successful hook cleanup", async () => {
    getReadable.mockReturnValue(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    );
    await expect(waitForWorkflowCleanup("session-run")).rejects.toThrow(
      /closed before acknowledging hook cleanup/,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a committed task cancellation from one live stream", async () => {
    let stream!: ReadableStreamDefaultController<{ status: string }>;
    getReadable.mockReturnValue(
      new ReadableStream({
        start(controller) {
          stream = controller;
        },
      }),
    );
    const terminal = readWorkflowStreamUntil<{ status: string }>({
      accept: (view) => view.status === "cancelled",
      namespace: "task-view",
      operation: "task cancellation",
      runId: "task-run",
      startIndex: -1,
      timeoutMs: 2_500,
    });
    stream.enqueue({ status: "working" });
    await vi.advanceTimersByTimeAsync(1_000);
    stream.enqueue({ status: "cancelled" });
    await expect(terminal).resolves.toEqual({ status: "cancelled" });
    expect(getReadable).toHaveBeenCalledOnce();
  });

  it("cancels the stream reader at the deadline without retrying the read", async () => {
    const cancel = vi.fn();
    getReadable.mockReturnValue(new ReadableStream({ cancel }));
    const result = expect(waitForWorkflowCleanup("session-run", 1_000)).rejects.toBeInstanceOf(
      WorkflowStreamTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
    expect(getReadable).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates stream failures without converting them to successful completion", async () => {
    const error = new Error("stream storage unavailable");
    getReadable.mockReturnValue(
      new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      }),
    );
    await expect(waitForWorkflowCleanup("session-run")).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
