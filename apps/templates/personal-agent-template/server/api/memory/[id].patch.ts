import { memoryIdParamsSchema, patchMemoryBodySchema } from "~~/server/schemas/memory";
import { updateMemoryEntry } from "~~/server/utils/memory";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const { id } = await getValidatedRouterParams(event, memoryIdParamsSchema.parse);
  const body = await readValidatedBody(event, patchMemoryBodySchema.parse);

  const entry = await updateMemoryEntry(userId, id, body.content);
  if (!entry) {
    throw createError({
      statusCode: 404,
      statusMessage: "Memory entry not found",
    });
  }

  return { entry };
});
