import { describe, expect, it, vi } from "vitest";

import { ScheduleDispatcher } from "#channel/schedule.js";
import type { Runtime } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { sweepToolSessionSandboxes as sweep } from "#execution/tool-session/sandbox.js";
import { sweepToolSessionSandboxes } from "#public/sandbox/tool-session-sweep.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

vi.mock("#execution/tool-session/sandbox.js", () => ({
  sweepToolSessionSandboxes: vi.fn(async () => ({ deleted: ["eve-ts-vercel-1"], failed: [] })),
}));

describe("sweepToolSessionSandboxes", () => {
  it("sweeps the root agent's sandboxes when a schedule runs it", async () => {
    const sandboxRegistry = { sandbox: null };
    const bundle = { graph: { root: { sandboxRegistry } } } as unknown as CompiledBundle;
    const scope = new ContextContainer();
    scope.setVirtualContext(BundleKey, bundle);
    const dispatcher = new ScheduleDispatcher({ channels: [], runtime: {} as Runtime });

    await dispatcher.trigger(
      { run: sweepToolSessionSandboxes, scheduleId: "tool-session-sweep" },
      scope,
    );

    expect(sweep).toHaveBeenCalledWith({ registry: sandboxRegistry });
  });

  it("refuses to run outside a schedule, where it has no agent to sweep for", async () => {
    await expect(sweepToolSessionSandboxes()).rejects.toThrow(/only from a schedule handler/u);
  });
});
