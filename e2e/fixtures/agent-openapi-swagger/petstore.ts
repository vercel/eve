export const PETSTORE_SPEC = {
  swagger: "2.0",
  info: { title: "Sample Petstore", version: "1.0.0" },
  produces: ["application/json"],
  definitions: {
    Category: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "Category name, such as Dogs." } },
    },
    Pet: {
      type: "object",
      required: ["name", "status", "category", "photoUrls"],
      properties: {
        name: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["available", "pending", "sold"] },
        category: { $ref: "#/definitions/Category" },
        photoUrls: { type: "array", minItems: 1, items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
  paths: {
    "/store/{storeId}/pet": {
      post: {
        operationId: "addPet",
        summary: "Add a pet to a store's catalog.",
        consumes: ["application/json"],
        parameters: [
          { in: "path", name: "storeId", required: true, type: "string" },
          { in: "body", name: "body", required: true, schema: { $ref: "#/definitions/Pet" } },
        ],
        responses: { 200: { description: "The stored pet with its id." } },
      },
    },
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
  return `${host}${process.env.EVE_PUBLIC_ROUTE_PREFIX ?? ""}/fixture-petstore`;
}

/** The spec URL, carrying the preview protection bypass because spec fetches send no connection headers. */
export function petstoreSpecUrl(): string {
  const url = new URL(`${petstoreBaseUrl()}/swagger`);
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) url.searchParams.set("x-vercel-protection-bypass", bypass);
  return url.href;
}

/** Lets operation calls reach a protected preview deployment of this fixture. */
export function petstoreHeaders(): Record<string, string> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return bypass ? { "x-vercel-protection-bypass": bypass } : {};
}
