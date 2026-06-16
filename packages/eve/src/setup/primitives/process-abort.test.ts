import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { armProcessAbort } from "./process-abort.js";

function childProcessDouble(): ChildProcess & {
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>;
} {
  const child = new EventEmitter() as ChildProcess & {
    kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>;
  };
  child.kill = vi.fn(() => true);
  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("armProcessAbort", () => {
  it("terminates on abort and escalates a child that does not close", () => {
    vi.useFakeTimers();
    const child = childProcessDouble();
    const controller = new AbortController();
    const disarm = armProcessAbort(child, controller.signal);

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    vi.advanceTimersByTime(5_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    disarm();
  });

  it("removes the abort listener when the child has already closed", () => {
    const child = childProcessDouble();
    const controller = new AbortController();
    const disarm = armProcessAbort(child, controller.signal);

    disarm();
    controller.abort();

    expect(child.kill).not.toHaveBeenCalled();
  });
});
