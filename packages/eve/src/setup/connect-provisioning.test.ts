import { describe, expect, it, vi } from "vitest";

import { replaceConnectTrigger } from "./connect-provisioning.js";

const onOutput = vi.fn();

function options(runVercel = vi.fn(async () => true)) {
  return {
    connectorUid: "photon/my-agent",
    projectRoot: "/project",
    triggerPath: "/eve/v1/photon",
    onOutput,
    deps: { runVercel },
  };
}

describe("replaceConnectTrigger", () => {
  it("replaces a project-scoped production trigger destination", async () => {
    const runVercel = vi.fn(async () => true);

    await expect(
      replaceConnectTrigger({
        ...options(runVercel),
        projectId: "prj_123",
        orgId: "team_123",
        environment: "production",
      }),
    ).resolves.toEqual({ state: "attached" });

    expect(runVercel).toHaveBeenNthCalledWith(
      1,
      [
        "connect",
        "detach",
        "photon/my-agent",
        "--project",
        "prj_123",
        "--yes",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
    expect(runVercel).toHaveBeenNthCalledWith(
      2,
      [
        "connect",
        "attach",
        "photon/my-agent",
        "--project",
        "prj_123",
        "--environment",
        "production",
        "--triggers",
        "--trigger-path",
        "/eve/v1/photon",
        "--yes",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/project", nonInteractive: true }),
    );
  });

  it("does not attach when detaching fails", async () => {
    const runVercel = vi.fn(async () => false);

    await expect(replaceConnectTrigger(options(runVercel))).resolves.toEqual({
      state: "detach-failed",
    });
    expect(runVercel).toHaveBeenCalledOnce();
  });
});
