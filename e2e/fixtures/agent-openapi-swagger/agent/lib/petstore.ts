const localBaseUrl =
  process.env.WORKFLOW_LOCAL_BASE_URL ??
  `http://127.0.0.1:${process.env.PORT === undefined || process.env.PORT === "" ? "3000" : process.env.PORT}`;

export const PETSTORE_BASE_URL =
  process.env.VERCEL_URL === undefined || process.env.VERCEL_URL === ""
    ? localBaseUrl
    : `https://${process.env.VERCEL_URL}`;

export const PETSTORE_SPEC = {
  basePath: "/petstore",
  host: "127.0.0.1",
  info: {
    title: "Local Swagger Petstore",
    version: "1.0.0",
  },
  paths: {
    "/inventory": {
      get: {
        operationId: "getInventory",
        responses: {
          "200": {
            description: "Inventory counts.",
            schema: {
              properties: {
                available: { type: "integer" },
                pending: { type: "integer" },
                sold: { type: "integer" },
              },
              type: "object",
            },
          },
        },
        summary: "Read inventory counts.",
      },
    },
  },
  schemes: ["http"],
  swagger: "2.0",
} as const;
