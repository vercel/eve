import { threadIdParamsSchema } from "~~/server/schemas/threads";
import { getThreadForUser } from "~~/server/utils/threads";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, threadIdParamsSchema.parse);
  const userId = await requireSessionUserId(event);

  const thread = await getThreadForUser(userId, id);
  if (!thread) {
    throw createError({
      statusCode: 404,
      statusMessage: "Thread not found",
    });
  }

  return { thread };
});
