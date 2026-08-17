import type { AuthoringSetup } from "../authoring-case.js";

const inventoryOpenApiSource = `export const inventoryOpenApiSpec = {
  openapi: "3.0.3",
  info: { title: "Inventory API", version: "1.0.0" },
  paths: {
    "/stock/{sku}": {
      get: {
        operationId: "getStock",
        parameters: [
          {
            name: "sku",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "Current stock" } },
      },
    },
    "/stock/{sku}/reserve": {
      post: {
        operationId: "reserveStock",
        parameters: [
          {
            name: "sku",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "Reservation result" } },
      },
    },
  },
};
`;

export const inventoryOpenApiSetup: AuthoringSetup = {
  id: "inventory-openapi-v1",
  async onSession({ run, write }) {
    await run("mkdir -p agent/lib");
    await write("agent/lib/inventory-openapi.ts", inventoryOpenApiSource);
  },
};
