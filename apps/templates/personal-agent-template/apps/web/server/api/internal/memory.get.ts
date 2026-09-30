import { internalMemoryQuerySchema } from "~~/server/schemas/memory";
import { listMemoryForUser } from "~~/server/utils/memory";
import { getOrCreateProfileForUser } from "~~/server/utils/profile";
import { requireInternalRequest } from "~~/server/utils/internal-api";

export default defineEventHandler(async (event) => {
  requireInternalRequest(event);

  const { userId } = await getValidatedQuery(event, internalMemoryQuerySchema.parse);
  const [profile, memory] = await Promise.all([
    getOrCreateProfileForUser(userId),
    listMemoryForUser(userId),
  ]);

  return { profile, memory };
});
