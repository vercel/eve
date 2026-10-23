import { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork,
}));

describe("development build process", () => {
  beforeEach(() => {
    fork.mockReset();
    fork.mockReturnValue(new ChildProcess());
    vi.resetModules();
  });

  it("hides the development build process window", async () => {
    const { forkDevelopmentBuildProcess } = await import("./dev-build-host.js");

    forkDevelopmentBuildProcess();

    expect(fork).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ windowsHide: true }),
    );
  });
});
