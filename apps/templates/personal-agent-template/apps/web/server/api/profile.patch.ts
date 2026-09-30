import { patchProfileBodySchema } from "~~/server/schemas/profile";
import { updateProfileForUser } from "~~/server/utils/profile";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const body = await readValidatedBody(event, patchProfileBodySchema.parse);
  const profile = await updateProfileForUser(userId, body);

  if (!profile) {
    throw createError({
      statusCode: 404,
      statusMessage: "User not found",
    });
  }

  return { profile };
});
