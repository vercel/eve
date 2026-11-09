import assert from "node:assert/strict";
import { test } from "node:test";

import { northstarFulfillmentSetup } from "./northstar-fulfillment.ts";

test("seeds the Northstar contract beside the project the agent will create", async () => {
  const writes = [];
  await northstarFulfillmentSetup.onSession({
    workspace: "/vercel/sandbox/restock-agent",
    run: async () => assert.fail("setup must not run commands in the missing project directory"),
    write: async (path, content) => writes.push({ path, content }),
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/vercel/sandbox/northstar-openapi.json");
  const spec = JSON.parse(writes[0].content);
  const operations = Object.values(spec.paths).flatMap((path) =>
    Object.values(path).map((operation) => operation.operationId),
  );
  assert.deepEqual(operations.sort(), [
    "adjustStock",
    "createPurchaseOrder",
    "getStock",
    "listLowStock",
  ]);
});
