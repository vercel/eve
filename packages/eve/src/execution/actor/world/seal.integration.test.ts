import { describe, expect, it } from "vitest";

import type { ActorSeal } from "#execution/actor/actors.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import { withMemoryQueue } from "#execution/world/memory-queue.js";
import { describeActors } from "../actors.conformance.js";
import { runIdOf, streamNameOf } from "./runs.js";
import { worldActors } from "./world-actors.js";

// Actors on a World with a seal: every guarantee still holds, and the World keeps only what the
// seal returned. eve ships no seal; this one stands in for a World's per-run key.

const kind = {
  kind: "sealed",
  streamNamespace: "eve-sealed",
  workflowName: "eve/sealed",
};

const MARK = new TextEncoder().encode("sealed:");

/** Reverses a body and marks it, keyed by the actor so a body under another key won't open. */
function testSeal(): ActorSeal {
  const tag = (key: string) => new TextEncoder().encode(`${key}:`);
  return {
    async seal(key, body) {
      const prefix = tag(key);
      return new Uint8Array([...MARK, ...prefix, ...[...body].reverse()]);
    },
    async open(key, body) {
      const prefix = [...MARK, ...tag(key)];
      if (!prefix.every((byte, index) => body[index] === byte))
        throw new Error(`Not sealed for "${key}".`);
      return new Uint8Array([...body.subarray(prefix.length)].reverse());
    },
  };
}

describeActors("the memory World, sealed", async () => {
  const world = memoryWorld();
  const seal = testSeal();
  return {
    close: async () => {},
    elsewhere: () => worldActors(world, { ...kind, seal }),
    actors: worldActors(world, { ...kind, seal }),
    mailbox: false,
    queue: false,
  };
});

describeActors("the memory World with a queue, sealed", async () => {
  const world = withMemoryQueue(memoryWorld());
  const seal = testSeal();
  const sealedKind = { ...kind, queueNamespace: "evesealed" };
  return {
    close: async () => await world.close(),
    elsewhere: () => worldActors(world, { ...sealedKind, seal }),
    actors: worldActors(world, { ...sealedKind, seal }),
    mailbox: true,
    queue: true,
  };
});

describe("a sealed actor at rest", () => {
  it("keeps its meta, records and stream chunks only as the seal returned them", async () => {
    const world = memoryWorld();
    const actors = worldActors(world, { ...kind, seal: testSeal() });
    const key = actors.newKey();
    await actors.create(key, { meta: { secret: "meta-plaintext" } });
    const handle = await actors.open(key);
    await handle.append([{ kind: "test.state", value: "record-plaintext" }], { snapshot: true });
    await handle.stream.append(0, [new TextEncoder().encode("chunk-plaintext")]);

    const runId = runIdOf(kind, key);
    const events = await world.events.list({ resolveData: "all", runId });
    const kept: Uint8Array[] = [];
    for (const event of events.data) {
      const input = (event.eventData as { readonly input?: unknown } | undefined)?.input;
      if (input instanceof Uint8Array) kept.push(input);
    }
    const chunks = await world.streams.getChunks(runId, streamNameOf(kind, key));
    for (const chunk of chunks.data) kept.push(chunk.data);

    expect(kept.length).toBeGreaterThanOrEqual(3);
    const decoder = new TextDecoder();
    for (const body of kept) {
      expect(MARK.every((byte, index) => body[index] === byte)).toBe(true);
      expect(decoder.decode(body)).not.toMatch(/plaintext/);
    }
    // Record kinds stay readable, so a World's tools can show the actor without its key.
    const kinds = events.data.map(
      (event) => (event.eventData as { readonly stepName?: unknown } | undefined)?.stepName,
    );
    expect(kinds).toContain("test.state");

    expect(await actors.meta(key)).toEqual({ secret: "meta-plaintext" });
    expect((await actors.load(key))?.snapshot).toEqual({
      kind: "test.state",
      value: "record-plaintext",
    });
    expect((await actors.chunks(key)).map((chunk) => decoder.decode(chunk))).toEqual([
      "chunk-plaintext",
    ]);
  });

  it("keeps a mailbox message only as the seal returned it, and hands it over opened", async () => {
    const world = withMemoryQueue(memoryWorld());
    const actors = worldActors(world, { ...kind, seal: testSeal() });
    const key = actors.newKey();
    await actors.create(key, { aliases: ["sealed-alias"], meta: {} });
    await actors.send({ alias: "sealed-alias" }, { secret: "message-plaintext" });
    const events = await world.events.list({ resolveData: "all", runId: runIdOf(kind, key) });
    const received = events.data.filter((event) => event.eventType === "hook_received");
    expect(received).toHaveLength(1);
    const payload = (received[0]!.eventData as { readonly payload: Uint8Array }).payload;
    expect(MARK.every((byte, index) => payload[index] === byte)).toBe(true);
    expect(new TextDecoder().decode(payload)).not.toMatch(/plaintext/);
    const handle = await actors.open(key);
    expect((await handle.inbox()).map((message) => message.body)).toEqual([
      { secret: "message-plaintext" },
    ]);
    await world.close();
  });

  it("doesn't open under a seal that didn't seal it", async () => {
    const world = memoryWorld();
    const sealed = worldActors(world, { ...kind, seal: testSeal() });
    const key = sealed.newKey();
    await sealed.create(key, { meta: { a: 1 } });
    await expect(worldActors(world, kind).meta(key)).rejects.toThrow();
  });
});
