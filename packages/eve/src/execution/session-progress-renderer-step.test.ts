import { describe, expect, it, vi } from "vitest";

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
    vi.mocked(deserializeContext).mockResolvedValue({
      require: () => ({
        kind: "slack",
        progressDestination: () => ({ channelId: "C1", threadTs: "T1" }),
        progressRenderers: [
          { id: "failed", render: failed },
          { id: "status", render: rendered },
        ],
        state: { channelId: "C1", secret: "hidden", threadTs: "T1" },
      }),
    } as never);
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
      snapshot,
    });

    expect(failed).toHaveBeenCalledWith({
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
