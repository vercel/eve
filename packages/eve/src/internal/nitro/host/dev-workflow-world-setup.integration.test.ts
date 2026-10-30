import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installWorkflowTransportEnvironment } from "#internal/nitro/host/dev-workflow-world-setup.js";

const SESSION_SECRET = "development-transport-secret-0123456789";

describe("installWorkflowTransportEnvironment", () => {
  let appRoot: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (appRoot !== undefined) await rm(appRoot, { force: true, recursive: true });
  });

  it("shares one generated delivery secret across an app's local sessions", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-dev-delivery-secret-"));
    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", undefined);
    const install = () =>
      installWorkflowTransportEnvironment({
        appRoot: appRoot!,
        secret: SESSION_SECRET,
        workersOwnWorld: true,
      });

    // `eve dev` and a local `eve eval` beside it.
    const restoreDev = install();
    const devSecret = process.env.EVE_WORKFLOW_DELIVERY_SECRET;
    restoreDev();
    expect(process.env.EVE_WORKFLOW_DELIVERY_SECRET).toBeUndefined();
    const restoreEval = install();
    expect(devSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(process.env.EVE_WORKFLOW_DELIVERY_SECRET).toBe(devSecret);
    restoreEval();
    const { mode } = await stat(join(appRoot, ".eve", "workflow-delivery-secret"));
    // Windows reports no POSIX permission bits.
    if (process.platform !== "win32") expect(mode & 0o777).toBe(0o600);
  });

  it("keeps a configured secret and leaves the parent's local World without one", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-dev-delivery-secret-"));
    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", "developer-chosen-delivery-secret-0123456789");
    const restoreConfigured = installWorkflowTransportEnvironment({
      appRoot,
      secret: SESSION_SECRET,
      workersOwnWorld: true,
    });
    expect(process.env.EVE_WORKFLOW_DELIVERY_SECRET).toBe(
      "developer-chosen-delivery-secret-0123456789",
    );
    restoreConfigured();

    vi.stubEnv("EVE_WORKFLOW_DELIVERY_SECRET", undefined);
    const restoreLocal = installWorkflowTransportEnvironment({
      appRoot,
      secret: SESSION_SECRET,
      workersOwnWorld: false,
    });
    expect(process.env.EVE_WORKFLOW_DELIVERY_SECRET).toBeUndefined();
    restoreLocal();
    await expect(stat(join(appRoot, ".eve", "workflow-delivery-secret"))).rejects.toThrow();
  });
});
