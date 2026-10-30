import { slackLinkConsumeBodySchema } from "~~/server/schemas/slack";
import { consumeSlackLinkCode } from "~~/server/utils/slack-link-codes";
import { requireInternalRequest } from "~~/server/utils/internal-api";

export default defineEventHandler(async (event) => {
  requireInternalRequest(event);

  const body = await readValidatedBody(event, slackLinkConsumeBodySchema.parse);
  return consumeSlackLinkCode(body);
});
