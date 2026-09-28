import { phoneLinkQuerySchema } from "~~/server/schemas/phone";
import { getPhoneLinkByPhoneNumber } from "~~/server/utils/phone-links";
import { requireInternalRequest } from "~~/server/utils/internal-api";

export default defineEventHandler(async (event) => {
  requireInternalRequest(event);

  const { phoneNumber } = await getValidatedQuery(event, phoneLinkQuerySchema.parse);
  const link = await getPhoneLinkByPhoneNumber(phoneNumber);

  return { link: link ?? null };
});
