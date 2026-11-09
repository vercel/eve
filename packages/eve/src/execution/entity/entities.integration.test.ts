import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { memoryWorld } from "#execution/world/memory-world.js";
import { asRuntimeWorld } from "#execution/world/world-fit.js";
import { describeEntities } from "./entities.conformance.js";
import { worldEntities } from "./world/world-entities.js";

// The conformance suite (`entities.conformance.ts`) on today's Worlds: the memory World and
// Workflow's local World. Postgres and Vercel run it by hand.

const kind = {
  kind: "conformance",
  streamNamespace: "eve-conformance",
  workflowName: "eve/conformance",
};

describeEntities("the memory World", async () => {
  const world = memoryWorld();
  return {
    close: async () => {},
    elsewhere: () => worldEntities(world, kind),
    entities: worldEntities(world, kind),
  };
});

describeEntities("Workflow's local World", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eve-entities-"));
  const local = createWorld({ dataDir: directory, recoverActiveRuns: false });
  const world = asRuntimeWorld(local);
  return {
    async close() {
      await local.close?.();
      rmSync(directory, { force: true, recursive: true });
    },
    elsewhere: () => worldEntities(world, kind),
    entities: worldEntities(world, kind),
  };
});
