import { afterEach, expect, it, vi } from "vitest";
import { encodeDevelopmentWorldValue as encode } from "#internal/workflow/development-world-codec.js";
import { createHubVercelWorld } from "./index.js";

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
