import { posix } from "node:path";

import type { AuthoringSetup } from "../authoring-case.js";

/** The contract the Northstar API team hands over, as a plain OpenAPI document. */
export const northstarOpenApiSpec = {
  openapi: "3.0.3",
  info: { title: "Northstar Fulfillment API", version: "2.4.0" },
  servers: [{ url: "https://api.northstar-fulfillment.com" }],
  paths: {
    "/stock/{sku}": {
      get: {
        operationId: "getStock",
        summary: "Current on-hand, reserved, and par level for one SKU.",
        parameters: [{ name: "sku", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Stock level" } },
      },
    },
    "/stock/low": {
      get: {
        operationId: "listLowStock",
        summary: "SKUs whose on-hand quantity is below their par level.",
        parameters: [
          { name: "warehouse", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Low-stock SKUs" } },
      },
    },
    "/stock/{sku}/adjust": {
      post: {
        operationId: "adjustStock",
        summary: "Manually correct the on-hand count for a SKU.",
        parameters: [{ name: "sku", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["delta", "reason"],
                properties: { delta: { type: "integer" }, reason: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": { description: "Adjusted stock level" } },
      },
    },
    "/purchase-orders": {
      post: {
        operationId: "createPurchaseOrder",
        summary: "Submit a purchase order to the SKU's preferred supplier.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["sku", "quantity", "unitCostUsd"],
                properties: {
                  sku: { type: "string" },
                  quantity: { type: "integer", minimum: 1 },
                  unitCostUsd: { type: "number", exclusiveMinimum: 0 },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Submitted purchase order",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "string" }, status: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

export const northstarOpenApiFile = "northstar-openapi.json";

/**
 * Seeds the API contract next to, not inside, the project directory: the coding
 * agent creates the project itself, and `eve init` refuses a non-empty target.
 */
export const northstarFulfillmentSetup: AuthoringSetup = {
  id: "northstar-fulfillment-v1",
  async onSession({ workspace, write }) {
    await write(
      posix.join(posix.dirname(workspace), northstarOpenApiFile),
      `${JSON.stringify(northstarOpenApiSpec, null, 2)}\n`,
    );
  },
};
