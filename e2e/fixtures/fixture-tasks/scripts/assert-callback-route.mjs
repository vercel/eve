import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The existing remote HITL eval exercises callbacks under this service mount.
// Catch the doubled-prefix regression in the built artifact before deployment,
// rather than waiting for the remote child's callback to time out.
const fixture = JSON.parse(await readFile("vercel.json", "utf8"));
assert.equal(
  fixture.experimentalServices.eve.routePrefix,
  "/eve/v1",
  "The remote callback regression requires the /eve/v1 service mount.",
);

const functionConfig = ".vercel/output/functions/.well-known/workflow/v1/flow.func/.vc-config.json";
const flow = JSON.parse(await readFile(functionConfig, "utf8"));
const publicPrefix = flow.environment?.EVE_PUBLIC_ROUTE_PREFIX ?? "";
const expectedPath = "/eve/v1/callback/<token>";
const actualPath = `${publicPrefix}${expectedPath}`;

assert.equal(
  actualPath,
  expectedPath,
  `Callback route mismatch in ${functionConfig}: the /eve/v1 service route must not be added again as EVE_PUBLIC_ROUTE_PREFIX.`,
);
console.log(`Callback route verified: ${actualPath}`);
console.log("Remote delivery coverage: task.input.answer.accepted-complete.remote");
