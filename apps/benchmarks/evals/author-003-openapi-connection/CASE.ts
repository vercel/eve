import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { inventoryOpenApiSetup } from "../../lib/setups/inventory-openapi.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: inventoryOpenApiSetup,
  async interact({ send }) {
    await send(
      "Connect this agent to the inventory service described by the provided `agent/lib/inventory-openapi.ts` contract. Add an OpenAPI connection named `inventory` with base URL `https://api.northstar-fulfillment.com`. It should authenticate as the app with a bearer token from `INVENTORY_API_TOKEN`, and the model should only be able to discover the read-only `getStock` operation, not `reserveStock`.",
    );
  },
});
