import { deleteSlackLinkForAppUser } from "~~/server/utils/slack-links";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const appUserId = await requireSessionUserId(event);
  const removed = await deleteSlackLinkForAppUser(appUserId);
  return { removed };
});
