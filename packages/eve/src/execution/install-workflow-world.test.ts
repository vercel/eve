import { describe, expect, it, onTestFinished, vi } from "vitest";

import { EVE_VERSION_ATTRIBUTE } from "#execution/eve-workflow-attributes.js";
import { closeWorkflowWorld, installWorkflowWorld } from "#execution/install-workflow-world.js";
import { WORKFLOW_ENTRY_NAME } from "#execution/stable-workflow-names.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

async function installWorld(close: () => Promise<void>, start?: () => Promise<void>) {
  await installWorkflowWorld({
    world: { close, createQueueHandler: () => undefined, events: {}, specVersion: 9, start },
  } as never);
}

function captureConsoleError() {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  return error;
}

describe("closeWorkflowWorld", () => {
  it("closes the installed World once, so its timers cannot keep a stopped server alive", async () => {
    const close = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    await installWorld(close, start);

    await closeWorkflowWorld();
    await closeWorkflowWorld();

    expect(start).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Nitro runs `close` hooks in sequence; sandbox shutdown and the trace flush come after this one.
  it("logs a failed close instead of rejecting, so later Nitro close hooks still run", async () => {
    const error = captureConsoleError();
    await installWorld(async () => {
      throw new Error("pool already ended");
    });

    await expect(closeWorkflowWorld()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("pool already ended"));
  });

  it("stops waiting for a close that never settles, so later Nitro close hooks still run", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const error = captureConsoleError();
    await installWorld(() => new Promise<void>(() => {}));

    const closed = closeWorkflowWorld();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(closed).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("does nothing before a World is installed", async () => {
    await expect(closeWorkflowWorld()).resolves.toBeUndefined();
  });
});

describe("installWorkflowWorld", () => {
  // `eve start` boots its World through here; a run no eve version owns must not replay.
  it("guards the World's queue against replaying a stranded session run", async () => {
    const logs = captureLogRecords();
    const { name, version } = resolveInstalledPackageInfo();
    const runs: Record<string, Record<string, string>> = {
      run_stranded: {},
      run_owned: { [EVE_VERSION_ATTRIBUTE]: version },
    };
    let deliver: ((message: unknown, meta: unknown) => Promise<unknown>) | undefined;
    await installWorkflowWorld({
      world: {
        close: async () => {},
        createQueueHandler: (_prefix: string, handler: typeof deliver) => {
          deliver = handler;
          return async () => new Response();
        },
        events: {},
        runs: {
          get: async (runId: string) => ({ attributes: runs[runId], runId, status: "running" }),
        },
        specVersion: 9,
      },
    } as never);
    onTestFinished(() => closeWorkflowWorld());
    const handler = vi.fn(async () => "replayed");
    const { getWorld } = await import("#internal/workflow/runtime.js");
    (await getWorld()).createQueueHandler("__prefix_" as never, handler as never);
    const meta = { queueName: `__prefix_workflow//${name}//${WORKFLOW_ENTRY_NAME}` };

    await expect(deliver!({ runId: "run_stranded" }, meta)).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(logs.records.map((record) => record.message).join("\n")).toContain(
      'Skipping replay of stranded session run "run_stranded"',
    );
    await expect(deliver!({ runId: "run_owned" }, meta)).resolves.toBe("replayed");
  });
});
