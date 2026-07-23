import { beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileCleanupIntents, recordCleanupIntent } from "#cli/dev/local-server-cleanup.js";

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => '{"ownerPid":123,"runId":"stale-run"}\n'),
  readdir: vi.fn(async () => ["dev-cleanup-intent.stale-run.json"]),
  rm: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  readdir: mocks.readdir,
  rm: mocks.rm,
  writeFile: mocks.writeFile,
}));
vi.mock("#execution/sandbox/bindings/local.js", () => ({
  stopDevelopmentSandboxResources: mocks.stop,
}));

describe("local server cleanup intents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records and removes the current run intent", async () => {
    const remove = await recordCleanupIntent("/tmp/app", { ownerPid: 123, runId: "run-1" });
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/tmp/app/.eve/dev-cleanup-intent.run-1.json",
      '{"ownerPid":123,"runId":"run-1"}\n',
      "utf8",
    );
    await remove();
    expect(mocks.rm).toHaveBeenCalled();
  });

  it("reconciles stale run intents", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });
    try {
      await reconcileCleanupIntents("/tmp/app");
      expect(mocks.stop).toHaveBeenCalledWith({ appRoot: "/tmp/app", devRunId: "stale-run" });
      expect(mocks.rm).toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("leaves intents owned by live instances untouched", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      await reconcileCleanupIntents("/tmp/app");
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.rm).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});
