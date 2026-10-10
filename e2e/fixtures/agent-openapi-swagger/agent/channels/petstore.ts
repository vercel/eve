import { defineChannel, GET, POST } from "eve/channels";

import { PETSTORE_SPEC } from "../../petstore";

const STATUSES = new Set(["available", "pending", "sold"]);

/** Mirrors the `Pet` definition so a wrongly shaped call fails like a real API. */
function petProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "body must be a Pet object";
  const pet = value as Record<string, unknown>;
  if (typeof pet.name !== "string" || pet.name.length === 0) return "name is required";
  if (typeof pet.status !== "string" || !STATUSES.has(pet.status)) {
    return "status must be available, pending, or sold";
  }
  const category = pet.category as Record<string, unknown> | undefined;
  if (typeof category?.name !== "string") return "category.name is required";
  if (
    !Array.isArray(pet.photoUrls) ||
    pet.photoUrls.length === 0 ||
    !pet.photoUrls.every((url) => typeof url === "string")
  ) {
    return "photoUrls must be a non-empty array of strings";
  }
  return undefined;
}

export default defineChannel({
  routes: [
    GET("/fixture-petstore/swagger", async () => Response.json(PETSTORE_SPEC)),
    GET("/fixture-petstore/store/inventory", async () =>
      Response.json({ available: 7, pending: 2, sold: 3 }),
    ),
    POST("/fixture-petstore/store/:storeId/pet", async (request, { params }) => {
      const body: unknown = await request.json().catch(() => undefined);
      const problem = petProblem(body);
      if (problem !== undefined) return Response.json({ message: problem }, { status: 400 });
      return Response.json({ id: 4217, storeId: params.storeId, ...(body as object) });
    }),
  ],
});
