import { listMemoryForUser } from "~~/server/utils/memory";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const memory = await listMemoryForUser(userId);
  return { memory };
});
