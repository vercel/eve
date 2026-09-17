import { describe, expect, it, vi } from "vitest";

const { runEveAdd } = vi.hoisted(() => ({ runEveAdd: vi.fn() }));
vi.mock("./eve-add.js", () => ({ runEveAdd }));

import { installLocalRegistryItem } from "./local-registry-install.js";

const transform = {
  target: "agent/connections/linear.ts",
  apply: (source: string) => `${source}\ntransformed`,
};

describe("local self-modification registry installation", () => {
  it("runs direct installs without snapshots or transforms", async () => {
    runEveAdd.mockResolvedValueOnce({ kind: "installed" });
    const snapshotInstall = vi.fn();
    const applyTransform = vi.fn();

    await expect(
      installLocalRegistryItem({
        address: "extension/browserbase",
        appRoot: "/project",
        withSuspendedSource: async (task) => await task(),
        deps: { applyTransform, snapshotInstall },
      }),
    ).resolves.toEqual({ outcome: { kind: "installed" } });
    expect(snapshotInstall).not.toHaveBeenCalled();
    expect(applyTransform).not.toHaveBeenCalled();
  });

  it("applies a planned transform after installation", async () => {
    runEveAdd.mockResolvedValueOnce({ kind: "installed" });
    const applyTransform = vi.fn(async () => true);

    await expect(
      installLocalRegistryItem({
        address: "connection/linear",
        appRoot: "/project",
        transform,
        withSuspendedSource: async (task) => await task(),
        deps: {
          applyTransform,
          snapshotInstall: async () => [],
        },
      }),
    ).resolves.toEqual({ outcome: { kind: "installed" } });
    expect(applyTransform).toHaveBeenCalledWith("/project", transform);
  });

  it("rolls back the full install snapshot when a transform fails", async () => {
    runEveAdd.mockResolvedValueOnce({ kind: "installed" });
    const rollbackInstall = vi.fn(async () => ({ restored: true, changed: [] }));
    const snapshots = [{ path: "/project/package.json" }];

    await expect(
      installLocalRegistryItem({
        address: "connection/linear",
        appRoot: "/project",
        transform,
        withSuspendedSource: async (task) => await task(),
        deps: {
          applyTransform: async () => false,
          rollbackInstall,
          snapshotInstall: async () => snapshots,
        },
      }),
    ).resolves.toEqual({
      outcome: { kind: "installed" },
      transformFailure: { restored: true, changed: [] },
    });
    expect(rollbackInstall).toHaveBeenCalledWith("/project", snapshots);
  });
});
