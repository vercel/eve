import { slackMemberQuerySchema } from "~~/server/schemas/slack";
import { getSlackLinkForMember } from "~~/server/utils/slack-links";
import { requireInternalRequest } from "~~/server/utils/internal-api";

export default defineEventHandler(async (event) => {
  requireInternalRequest(event);

  const { teamId, userId } = await getValidatedQuery(event, slackMemberQuerySchema.parse);
  const link = await getSlackLinkForMember(teamId, userId);

  return { link: link ?? null };
});
