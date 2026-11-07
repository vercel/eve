import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { localWorld } from "#execution/world/local-world.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import { describeEntities } from "./entities.conformance.js";
import { worldEntities } from "./world/world-entities.js";

// The conformance suite (`entities.conformance.ts`) on today's Worlds: the memory World (no
// mailbox, no queue) and Workflow's local World. Postgres and Vercel run it by hand.

const kind = {
  kind: "conformance",
  queueNamespace: "eveconformance",
  streamNamespace: "eve-conformance",
  workflowName: "eve/conformance",
};

describeEntities("the memory World", async () => {
  const world = memoryWorld();
  return {
    close: async () => {},
    elsewhere: () => worldEntities(world, kind),
    entities: worldEntities(world, kind),
    mailbox: false,
    queue: false,
  };
});

describeEntities("Workflow's local World", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eve-entities-"));
  const world = localWorld({ dataDir: directory });
  return {
    async close() {
      await world.close?.();
      rmSync(directory, { force: true, recursive: true });
    },
    elsewhere: () => worldEntities(world, kind),
    entities: worldEntities(world, kind),
    mailbox: true,
    queue: true,
  };
});

describe("entities on a World others run on too", () => {
  it("don't take a hook another kind's run holds for one of theirs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eve-entities-shared-"));
    const world = localWorld({ dataDir: directory });
    try {
      // Another kind on the same World, as Workflow's own runs are beside a World host's.
      const others = worldEntities(world, { ...kind, kind: "other", workflowName: "eve/other" });
      const entities = worldEntities(world, kind);
      const theirs = others.newKey();
      await others.create(theirs, { aliases: ["their-address"], meta: {} });
      await expect(entities.lookup("their-address")).resolves.toBeUndefined();
      await expect(
        entities.send({ alias: "their-address" }, { hello: true }),
      ).resolves.toBeUndefined();
      // Theirs still reaches them.
      await expect(others.lookup("their-address")).resolves.toBe(theirs);
    } finally {
      await world.close?.();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
