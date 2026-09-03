export function resolvePetstoreBaseUrl(): string {
  const localBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL?.trim();
  if (localBaseUrl !== undefined && localBaseUrl.length > 0) {
    return localBaseUrl;
  }

  const deploymentHost = process.env.VERCEL_URL?.trim();
  if (deploymentHost !== undefined && deploymentHost.length > 0) {
    return `https://${deploymentHost}`;
  }

  const localPort = process.env.PORT?.trim();
  return `http://127.0.0.1:${localPort === undefined || localPort.length === 0 ? "3000" : localPort}`;
}

export function resolvePetstoreHeaders(): Record<string, string> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return bypass === undefined || bypass.length === 0
    ? {}
    : { "x-vercel-protection-bypass": bypass };
}

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
