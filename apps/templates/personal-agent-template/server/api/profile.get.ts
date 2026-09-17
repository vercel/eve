import { getProfileWithUser } from "~~/server/utils/profile";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const profile = await getProfileWithUser(userId);

  if (!profile) {
    throw createError({
      statusCode: 404,
      statusMessage: "User not found",
    });
  }

  return { profile };
});
