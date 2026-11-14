import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { localWorld } from "#execution/world/local-world.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import { withMemoryQueue } from "#execution/world/memory-queue.js";
import { describeActors } from "./actors.conformance.js";
import { worldActors } from "./world/world-actors.js";

// The conformance suite (`actors.conformance.ts`) on today's Worlds: the memory World (no
// mailbox, no queue), the same with a queue in this process (`memory-queue.ts`), and Workflow's
// local World. Postgres and Vercel run it by hand.

const kind = {
  kind: "conformance",
  queueNamespace: "eveconformance",
  streamNamespace: "eve-conformance",
  workflowName: "eve/conformance",
};

describeActors("the memory World", async () => {
  const world = memoryWorld();
  return {
    close: async () => {},
    elsewhere: () => worldActors(world, kind),
    actors: worldActors(world, kind),
    mailbox: false,
    queue: false,
  };
});

describeActors("the memory World, with a queue in this process", async () => {
  const world = withMemoryQueue(memoryWorld());
  return {
    close: async () => await world.close(),
    elsewhere: () => worldActors(world, kind),
    actors: worldActors(world, kind),
    mailbox: true,
    queue: true,
  };
});

describeActors("Workflow's local World", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eve-actors-"));
  const world = localWorld({ dataDir: directory });
  return {
    async close() {
      await world.close?.();
      rmSync(directory, { force: true, recursive: true });
    },
    elsewhere: () => worldActors(world, kind),
    actors: worldActors(world, kind),
    mailbox: true,
    queue: true,
  };
});

describe("actors on a World others run on too", () => {
  it("don't take a hook another kind's run holds for one of theirs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eve-actors-shared-"));
    const world = localWorld({ dataDir: directory });
    try {
      // Another kind on the same World, as Workflow's own runs are beside a World host's.
      const others = worldActors(world, { ...kind, kind: "other", workflowName: "eve/other" });
      const actors = worldActors(world, kind);
      const theirs = others.newKey();
      await others.create(theirs, { aliases: ["their-address"], meta: {} });
      await expect(actors.lookup("their-address")).resolves.toBeUndefined();
      await expect(
        actors.send({ alias: "their-address" }, { hello: true }),
      ).resolves.toBeUndefined();
      // Theirs still reaches them.
      await expect(others.lookup("their-address")).resolves.toBe(theirs);
    } finally {
      await world.close?.();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
