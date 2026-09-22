export const PETSTORE_SPEC = {
  swagger: "2.0",
  info: { title: "Sample Petstore", version: "1.0.0" },
  produces: ["application/json"],
  paths: {
    "/store/inventory": {
      get: {
        operationId: "getInventory",
        summary: "Return inventory counts by pet status.",
        responses: {
          200: {
            description: "Inventory counts.",
            schema: { type: "object", additionalProperties: { type: "integer" } },
          },
        },
      },
    },
  },
};

export function petstoreBaseUrl(): string {
  const deploymentHost = process.env.VERCEL_URL;
  const host = deploymentHost
    ? `https://${deploymentHost}`
    : (process.env.WORKFLOW_LOCAL_BASE_URL ?? "http://127.0.0.1:3000");
  return `${host}/fixture-petstore`;
}
