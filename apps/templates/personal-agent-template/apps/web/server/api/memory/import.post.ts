import { importMemoryBodySchema } from "~~/server/schemas/memory";
import { importMemoryForUser } from "~~/server/utils/memory";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);
  const body = await readValidatedBody(event, importMemoryBodySchema.parse);
  const result = await importMemoryForUser(userId, body.raw);
  return result;
});
