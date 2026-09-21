import { createThreadBodySchema } from "~~/server/schemas/threads";
import { createThreadForUser } from "~~/server/utils/threads";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const body = await readValidatedBody(event, createThreadBodySchema.parse);
  const thread = await createThreadForUser(userId, body);
  setResponseStatus(event, 201);
  return { thread };
});
