import { createSlackLinkCode } from "~~/server/utils/slack-link-codes";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const appUserId = await requireSessionUserId(event);
  const { code, expiresAt } = await createSlackLinkCode(appUserId);

  return { code, expiresAt };
});
