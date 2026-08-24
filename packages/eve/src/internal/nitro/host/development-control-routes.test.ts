import { describe, expect, it, vi } from "vitest";

import { handleDevelopmentControlRoute } from "#internal/nitro/host/development-control-routes.js";
import { getHostRouteRegistrations } from "#protocol/host-route-inventory.js";

function createInput() {
  const watcher = {
    close: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
  };
  const workflowWorld = {
    close: vi.fn(async () => undefined),
    handleRequest: vi.fn(async (request: Request) => new Response(new URL(request.url).pathname)),
    start: vi.fn(async () => undefined),
  };
  return {
    input: {
      appRoot: "/tmp/eve-test",
      getReadyServerId: () => "server-id",
      getWatcher: () => watcher,
      workflowWorld,
    },
    watcher,
    workflowWorld,
  };
}

describe("handleDevelopmentControlRoute", () => {
  it.each(getHostRouteRegistrations("development-control"))(
    "dispatches the $id $method registration",
    async (registration) => {
      const { input } = createInput();
      const response = await handleDevelopmentControlRoute(
        input,
        new Request(`http://localhost${registration.pathPattern}`, {
          method: registration.method,
        }),
      );

      expect(response).toBeInstanceOf(Response);
    },
  );

  it("does not claim an unregistered method or path", async () => {
    const { input } = createInput();

    await expect(
      handleDevelopmentControlRoute(
        input,
        new Request("http://localhost/eve/v1/dev/runtime-artifacts", { method: "POST" }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      handleDevelopmentControlRoute(input, new Request("http://localhost/authored")),
    ).resolves.toBeUndefined();
  });

  it("dispatches each control behavior through its inventory id", async () => {
    const { input, watcher } = createInput();

    await handleDevelopmentControlRoute(
      input,
      new Request("http://localhost/eve/v1/dev/runtime-artifacts/rebuild?force=1"),
    );
    await handleDevelopmentControlRoute(
      input,
      new Request("http://localhost/eve/v1/dev/runtime-artifacts/rebuild", { method: "POST" }),
    );
    await handleDevelopmentControlRoute(
      input,
      new Request("http://localhost/eve/v1/dev/runtime-artifacts/suspend", { method: "POST" }),
    );
    await handleDevelopmentControlRoute(
      input,
      new Request("http://localhost/eve/v1/dev/runtime-artifacts/resume?silent=1", {
        method: "POST",
      }),
    );

    expect(watcher.rebuild).toHaveBeenCalledOnce();
    expect(watcher.flush).toHaveBeenCalledOnce();
    expect(watcher.suspend).toHaveBeenCalledOnce();
    expect(watcher.resume).toHaveBeenCalledWith({ silent: true });
  });

  it("dispatches every Workflow World endpoint interception through the inventory", async () => {
    const { input, workflowWorld } = createInput();

    await handleDevelopmentControlRoute(
      input,
      new Request("http://localhost/eve/v1/dev/internal/workflow-world", { method: "POST" }),
    );
    await handleDevelopmentControlRoute(
      input,
      new Request("http://localhost/eve/v1/dev/internal/workflow-world/stream"),
    );
    const wrongMethod = await handleDevelopmentControlRoute(
      input,
      new Request("http://localhost/eve/v1/dev/internal/workflow-world"),
    );

    expect(workflowWorld.handleRequest).toHaveBeenCalledTimes(3);
    expect(wrongMethod).toBeInstanceOf(Response);
  });

  it("returns startup status for watcher-backed control routes before the watcher exists", async () => {
    const { input } = createInput();
    const response = await handleDevelopmentControlRoute(
      { ...input, getWatcher: () => undefined },
      new Request("http://localhost/eve/v1/dev/runtime-artifacts/rebuild"),
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      error: "The development server is still starting.",
    });
  });
});
