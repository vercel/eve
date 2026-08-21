import { describe, expect, it, vi } from "vitest";

import { attachChannelProgressPresentation } from "#channel/progress-renderer.js";
import { deserializeContext } from "#context/serialize.js";
import { createProgressSnapshot } from "#execution/session-progress.js";
import { renderSessionProgressStep } from "#execution/session-progress-renderer-step.js";

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));

vi.mock("#internal/logging.js", () => ({
  createLogger: () => ({ error: vi.fn() }),
  logError: vi.fn(),
}));

describe("renderSessionProgressStep", () => {
  it("isolates renderer state and continues after a renderer failure", async () => {
    const failed = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const rendered = vi.fn().mockResolvedValue({ status: "Working..." });
    const adapter = {
      kind: "slack",
      state: { channelId: "C1", secret: "hidden", threadTs: "T1" },
    };
    attachChannelProgressPresentation(adapter, {
      destination: () => ({ channelId: "C1", threadTs: "T1" }),
      renderers: [
        { id: "failed", render: failed },
        { id: "status", render: rendered },
      ],
    });
    vi.mocked(deserializeContext).mockResolvedValue({ require: () => adapter } as never);
    const snapshot = createProgressSnapshot();

    await expect(
      renderSessionProgressStep({
        rendererStates: { failed: { attempt: 1 }, status: { status: "Thinking..." } },
        serializedContext: {},
        snapshot,
      }),
    ).resolves.toEqual({
      rendererStates: {
        failed: { attempt: 1 },
        status: { status: "Working..." },
      },
    });

    expect(failed).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenLastCalledWith({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot,
      state: { attempt: 1 },
    });
    expect(rendered).toHaveBeenCalledWith({
      destination: { channelId: "C1", threadTs: "T1" },
      snapshot,
      state: { status: "Thinking..." },
    });
  });
});
