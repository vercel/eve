import { listThreadsForUser } from "~~/server/utils/threads";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const threads = await listThreadsForUser(userId);
  return { threads };
});
