import { getPendingSlackLinkCode } from "~~/server/utils/slack-link-codes";
import { getSlackLinkForAppUser, toSlackLinkSummary } from "~~/server/utils/slack-links";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const appUserId = await requireSessionUserId(event);
  const link = await getSlackLinkForAppUser(appUserId);
  const pending = await getPendingSlackLinkCode(appUserId);

  return {
    ...toSlackLinkSummary(link),
    pendingCode: pending?.code,
    pendingExpiresAt: pending?.expiresAt,
  };
});
