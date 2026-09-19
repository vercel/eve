import type { ExecHandle as MicrosandboxExecHandle } from "microsandbox";
import { describe, expect, it, vi } from "vitest";

import { adaptMicrosandboxExecToSandboxProcess } from "#execution/sandbox/bindings/microsandbox-process.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";

type ExecEvent =
  | { readonly kind: "stdout" | "stderr"; readonly data: Uint8Array }
  | { readonly kind: "exited"; readonly code: number };

/**
 * Builds a fake microsandbox exec handle. After the scripted `events` are
 * exhausted the iterator either stalls forever (`tail: "stall"`, the wedged-exec
 * case the idle backstop guards against) or reports the stream as ended
 * (`tail: "done"`).
 */
function createFakeExecHandle(
  events: ExecEvent[],
  tail: "stall" | "done",
): MicrosandboxExecHandle & { kill: ReturnType<typeof vi.fn> } {
  const queue = [...events];
  const kill = vi.fn(async () => {});
  return {
    kill,
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const event = queue.shift();
          if (event !== undefined) {
            return { done: false, value: event };
          }
          if (tail === "done") {
            return { done: true, value: undefined };
          }
          // Stall: never resolve, never close.
          return new Promise<IteratorResult<ExecEvent>>(() => {});
        },
      };
    },
  } as unknown as MicrosandboxExecHandle & { kill: ReturnType<typeof vi.fn> };
}

describe("adaptMicrosandboxExecToSandboxProcess", () => {
  it("resolves with the exit code and delivers stdout on a clean exit", async () => {
    const handle = createFakeExecHandle(
      [
        { data: Buffer.from("hello\n"), kind: "stdout" },
        { code: 0, kind: "exited" },
      ],
      "done",
    );

    const process = adaptMicrosandboxExecToSandboxProcess(handle, { idleTimeoutMs: 1000 });
    const [stdout, status] = await Promise.all([streamToBuffer(process.stdout), process.wait()]);

    expect(stdout.toString()).toBe("hello\n");
    expect(status).toEqual({ exitCode: 0 });
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it("kills the command and rejects when the stream stalls without an exit event", async () => {
    const handle = createFakeExecHandle(
      [{ data: Buffer.from("partial\n"), kind: "stdout" }],
      "stall",
    );

    const process = adaptMicrosandboxExecToSandboxProcess(handle, { idleTimeoutMs: 50 });
    // Drain stdout so its errored stream does not surface as an unhandled rejection.
    void streamToBuffer(process.stdout).catch(() => {});

    await expect(process.wait()).rejects.toThrow(
      "Microsandbox command exceeded idle timeout (50ms with no output or exit event).",
    );
    expect(handle.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects with the ended-without-exit error when the stream closes before exiting", async () => {
    const handle = createFakeExecHandle(
      [{ data: Buffer.from("partial\n"), kind: "stdout" }],
      "done",
    );

    const process = adaptMicrosandboxExecToSandboxProcess(handle, { idleTimeoutMs: 1000 });
    void streamToBuffer(process.stdout).catch(() => {});

    await expect(process.wait()).rejects.toThrow(
      "Microsandbox command ended without an exit event.",
    );
    expect(handle.kill).not.toHaveBeenCalled();
  });
});
