import assert from "node:assert/strict";
import { test } from "node:test";

import { inventoryOpenApiSetup } from "./inventory-openapi.ts";

test("seeds the inventory OpenAPI contract into the project", async () => {
  const commands = [];
  const writes = [];
  await inventoryOpenApiSetup.onSession({
    run: async (command) => commands.push(command),
    write: async (path, content) => writes.push({ path, content }),
  });

  assert.deepEqual(commands, ["mkdir -p agent/lib"]);
  assert.equal(writes[0]?.path, "agent/lib/inventory-openapi.ts");
  assert.match(writes[0]?.content ?? "", /operationId: "getStock"/u);
  assert.match(writes[0]?.content ?? "", /operationId: "reserveStock"/u);
});
