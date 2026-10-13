import { afterEach, expect, it, vi } from "vitest";
import { encodeDevelopmentWorldValue as encode } from "#internal/workflow/development-world-codec.js";
import { createHubVercelWorld, createVercelQueueWorld } from "./index.js";

const queue = vi.hoisted(() => ({
  queue: vi.fn(),
  queueBatch: vi.fn(),
  createQueueHandler: vi.fn(),
  getDeploymentId: vi.fn(),
  isDeploymentUnavailableError: vi.fn(),
}));
vi.mock("#compiled/@workflow/world-vercel/index.js", () => ({ createQueue: () => queue }));
afterEach(() => vi.restoreAllMocks());

it("uses Vercel queue methods and hub persistence and streams", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(
        encode({
          specVersion: 8,
          capabilities: { hookRetention: { active: true } },
          operations: ["runs.get", "events.create", "streams.getChunks"],
        }),
      ),
    )
    .mockImplementation(async () => new Response(encode("hub-result")));
  const world = await createHubVercelWorld({ url: "https://hub.test", secret: "secret" });
  try {
    for (const [name, method] of Object.entries(queue))
      expect(world[name as keyof typeof world]).toBe(method);
    expect(world.specVersion).toBe(8);
    expect(world.capabilities).toEqual({ hookRetention: { active: true } });
    expect(await world.runs.get("run")).toBe("hub-result");
    expect(await world.streams.getChunks("run", "stream")).toBe("hub-result");
    expect(world.events.create).toBeTypeOf("function");
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    await world.close?.();
  }
});

it("composes direct storage with Vercel delivery without changing storage options", async () => {
  const storage = {
    specVersion: 8,
    capabilities: { hookRetention: { active: true } },
    events: { create: vi.fn() },
    streams: { write: vi.fn() },
    queue: vi.fn(),
    streamFlushIntervalMs: 100,
  };
  const world = await createVercelQueueWorld(storage as never);
  expect(world.events).toBe(storage.events);
  expect(world.streams).toBe(storage.streams);
  expect(world.capabilities).toBe(storage.capabilities);
  expect(world.queue).toBe(queue.queue);
  expect(world.createQueueHandler).toBe(queue.createQueueHandler);
  expect(world.streamFlushIntervalMs).toBe(100);
});
