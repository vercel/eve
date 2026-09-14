import { threadIdParamsSchema } from "~~/server/schemas/threads";
import { deleteThreadForUser } from "~~/server/utils/threads";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, threadIdParamsSchema.parse);
  const userId = await requireSessionUserId(event);

  const deleted = await deleteThreadForUser(userId, id);
  if (!deleted) {
    throw createError({
      statusCode: 404,
      statusMessage: "Thread not found",
    });
  }

  return { ok: true };
});
