import { memoryIdParamsSchema } from "~~/server/schemas/memory";
import { deleteMemoryEntry } from "~~/server/utils/memory";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const { id } = await getValidatedRouterParams(event, memoryIdParamsSchema.parse);

  const deleted = await deleteMemoryEntry(userId, id);
  if (!deleted) {
    throw createError({
      statusCode: 404,
      statusMessage: "Memory entry not found",
    });
  }

  return { ok: true };
});
