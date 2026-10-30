import { getConnector } from "~~/server/connectors";
import { connectQuerySchema, connectorIdParamsSchema } from "~~/server/schemas/integrations";
import { isValidEveResumeUrl, startConnectFlow } from "~~/server/utils/connect";
import { throwConnectError } from "~~/server/utils/errors";
import { getRequestOrigin } from "~~/server/utils/h3-node";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, connectorIdParamsSchema.parse);
  const { resumeUrl } = await getValidatedQuery(event, connectQuerySchema.parse);

  const connector = getConnector(id);
  const userId = await requireSessionUserId(event);
  const origin = getRequestOrigin(event);

  const callbackUrl =
    resumeUrl && isValidEveResumeUrl(resumeUrl, origin)
      ? resumeUrl
      : `${origin}/settings/integrations?connected=${connector.id}`;

  try {
    const { url } = await startConnectFlow(connector, userId, callbackUrl);
    return { url };
  } catch (error) {
    throwConnectError(error);
  }
});
