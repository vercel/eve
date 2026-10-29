import { describe, expect, it, vi } from "vitest";

import type { World } from "#compiled/@workflow/world/index.js";
import { installWorkflowWorld } from "#execution/install-workflow-world.js";

vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: vi.fn(async () => undefined),
  setWorld: vi.fn(),
}));

const PREFIX = "__wkf_workflow_";
type DeliveryHandler = ReturnType<World["createQueueHandler"]>;

function createWorld() {
  const registered = new Map<string, DeliveryHandler>();
  const deliver = vi.fn(async (_request: Request) => new Response("delivered"));
  const world = {
    events: {},
    specVersion: 3,
    start: vi.fn(async () => {}),
    createQueueHandler: (() => deliver) as World["createQueueHandler"],
    registerHandler: ((prefix, handler) => {
      registered.set(prefix, handler);
    }) satisfies NonNullable<World["registerHandler"]>,
  };
  return { world, registered, deliver };
}

function request() {
  return new Request("http://localhost/.well-known/workflow/v1/flow", {
    method: "POST",
    body: "ordinary queued work",
  });
}

describe("Postgres Workflow delivery protection", () => {
  it("allows registered queue deliveries but rejects HTTP requests before processing their body", async () => {
    const { world, registered, deliver } = createWorld();
    await installWorkflowWorld({ packageName: "@workflow/world-postgres", world });
    const handle = world.createQueueHandler(PREFIX, async () => {});
    world.registerHandler(PREFIX, handle);

    const external = request();
    expect((await handle(external)).status).toBe(401);
    expect(external.bodyUsed).toBe(false);
    expect(deliver).not.toHaveBeenCalled();

    const internal = request();
    expect((await registered.get(PREFIX)!(internal)).status).toBe(200);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(internal);
    expect((await handle(internal)).status).toBe(401);
  });

  it("does not admit another request while an internal delivery is in progress", async () => {
    const { world, registered, deliver } = createWorld();
    await installWorkflowWorld({ packageName: "@workflow/world-postgres", world });
    const handle = world.createQueueHandler(PREFIX, async () => {});
    world.registerHandler(PREFIX, handle);
    const release = Promise.withResolvers<Response>();
    deliver.mockImplementationOnce(() => release.promise);

    const internal = request();
    const pending = registered.get(PREFIX)!(internal);
    try {
      expect((await handle(internal.clone())).status).toBe(401);
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve(new Response("delivered"));
      await pending;
    }
  });

  it("clears delivery trust after a handler failure and permits a queued retry", async () => {
    const { world, registered, deliver } = createWorld();
    await installWorkflowWorld({ packageName: "@workflow/world-postgres", world });
    const handle = world.createQueueHandler(PREFIX, async () => {});
    world.registerHandler(PREFIX, handle);
    deliver.mockRejectedValueOnce(new Error("retry this job"));
    const internal = request();

    await expect(registered.get(PREFIX)!(internal)).rejects.toThrow("retry this job");
    expect((await handle(internal)).status).toBe(401);
    expect((await registered.get(PREFIX)!(request())).status).toBe(200);
  });

  it("fails before starting a Postgres world without in-process delivery support", async () => {
    const { world } = createWorld();
    const legacy = { ...world, registerHandler: undefined };

    await expect(
      installWorkflowWorld({ packageName: "@workflow/world-postgres", world: legacy }),
    ).rejects.toThrow("Install @workflow/world-postgres@^5.0.5 and rebuild the agent.");
    expect(world.start).not.toHaveBeenCalled();
  });

  it.each([undefined, "@workflow/world-vercel", "@acme/workflow-world"])(
    "preserves the delivery policy of %s",
    async (packageName) => {
      const { world, deliver } = createWorld();
      await installWorkflowWorld({ packageName, world });
      const handle = world.createQueueHandler(PREFIX, async () => {});
      expect((await handle(request())).status).toBe(200);
      expect(deliver).toHaveBeenCalledTimes(1);
    },
  );
});
