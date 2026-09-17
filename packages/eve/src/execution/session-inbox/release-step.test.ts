import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { releaseSessionHooksStep } from "./release-step.js";

const mocks = vi.hoisted(() => ({ create: vi.fn(), getByToken: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: async () => ({
    events: { create: mocks.create },
    hooks: { getByToken: mocks.getByToken },
  }),
}));

beforeEach(() => vi.resetAllMocks());

describe("releaseSessionHooksStep", () => {
  it("commits disposal for each exact owned hook", async () => {
    mocks.getByToken.mockImplementation(async (token: string) => ({
      hookId: `hook-${token}`,
      runId: "owner",
      specVersion: 7,
    }));
    await releaseSessionHooksStep({ ownerRunId: "owner", tokens: ["stable", "alias"] });
    for (const token of ["stable", "alias"]) {
      expect(mocks.create).toHaveBeenCalledWith("owner", {
        correlationId: `hook-${token}`,
        eventData: { token },
        eventType: "hook_disposed",
        specVersion: 7,
      });
    }
  });

  it("finishes a retry after an earlier attempt released part of the hook set", async () => {
    mocks.getByToken.mockRejectedValueOnce(new HookNotFoundError("stable"));
    mocks.getByToken.mockResolvedValueOnce({
      hookId: "hook-alias",
      runId: "owner",
      specVersion: 7,
    });
    await releaseSessionHooksStep({ ownerRunId: "owner", tokens: ["stable", "alias"] });
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("never disposes another owner's claim", async () => {
    mocks.getByToken.mockResolvedValue({ hookId: "new-claim", runId: "successor" });
    await expect(
      releaseSessionHooksStep({ ownerRunId: "owner", tokens: ["stable"] }),
    ).rejects.toThrow("owned by another workflow");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("propagates disposal failures so the reader is not stopped early", async () => {
    mocks.getByToken.mockResolvedValue({ hookId: "claim", runId: "owner", specVersion: 7 });
    const failure = new Error("storage unavailable");
    mocks.create.mockRejectedValue(failure);
    await expect(releaseSessionHooksStep({ ownerRunId: "owner", tokens: ["stable"] })).rejects.toBe(
      failure,
    );
  });
});
