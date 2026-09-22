import { patchThreadBodySchema, threadIdParamsSchema } from "~~/server/schemas/threads";
import { updateThreadForUser } from "~~/server/utils/threads";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, threadIdParamsSchema.parse);
  const userId = await requireSessionUserId(event);
  const body = await readValidatedBody(event, patchThreadBodySchema.parse);

  const thread = await updateThreadForUser(userId, id, body);
  if (!thread) {
    throw createError({
      statusCode: 404,
      statusMessage: "Thread not found",
    });
  }

  return { thread };
});
