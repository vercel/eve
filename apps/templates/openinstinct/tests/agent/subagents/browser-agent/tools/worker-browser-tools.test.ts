import { beforeEach, describe, expect, it, vi } from "vitest";
import * as WorkerAccess from "@agent/subagents/browser-agent/lib/access";
import * as OwnedBrowser from "@agent/subagents/browser-agent/lib/owned-browser";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import { toolContextFor } from "@tests/helpers/tool-context";
import computerAction from "@agent/subagents/browser-agent/tools/computer_action";

const mocks = {
  batch: vi.spyOn(kernel.browsers.computer, "batch"),
  readClipboard: vi.spyOn(kernel.browsers.computer, "readClipboard"),
  requireOwnedBrowserSession: vi.spyOn(
    OwnedBrowser,
    "requireOwnedBrowserSession"
  ),
  requireWorkerScope: vi.spyOn(WorkerAccess, "requireWorkerScope"),
  writeClipboard: vi.spyOn(kernel.browsers.computer, "writeClipboard"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkerScope.mockResolvedValue({
    userId: "user-1",
    workspaceId: "workspace-1",
  });
  mocks.requireOwnedBrowserSession.mockResolvedValue({
    createdAt: "2026-08-31T00:00:00.000Z",
    sessionId: "browser-1",
    workerSessionId: "worker-session-1",
  });
  mocks.batch.mockResolvedValue();
  mocks.readClipboard.mockResolvedValue({ text: "clipboard value" });
  mocks.writeClipboard.mockResolvedValue();
});

describe("worker browser tools", () => {
  it("sends contiguous computer actions through Kernel batch while preserving read order", async () => {
    const execute = computerAction.execute;
    const context = toolContextFor();
    const result = await execute(
      {
        actions: [
          { click_mouse: { x: 10, y: 20 }, type: "click_mouse" },
          { type: "type_text", type_text: { text: "hello" } },
          { sleep: { duration_ms: 100 }, type: "sleep" },
          { type: "read_clipboard" },
          { scroll: { x: 10, y: 20, delta_y: 4 }, type: "scroll" },
        ],
        session_id: "browser-1",
      },
      context
    );

    expect(mocks.batch).toHaveBeenCalledTimes(2);
    expect(mocks.batch).toHaveBeenNthCalledWith(
      1,
      "browser-1",
      {
        actions: [
          { click_mouse: { x: 10, y: 20 }, type: "click_mouse" },
          { type: "type_text", type_text: { text: "hello" } },
          { sleep: { duration_ms: 100 }, type: "sleep" },
        ],
      },
      { signal: context.abortSignal }
    );
    expect(mocks.batch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readClipboard.mock.invocationCallOrder[0] ?? Infinity
    );
    expect(mocks.readClipboard.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.batch.mock.invocationCallOrder[1] ?? Infinity
    );
    expect(result).toMatchObject({ data: [{ text: "clipboard value" }] });
  });
});
