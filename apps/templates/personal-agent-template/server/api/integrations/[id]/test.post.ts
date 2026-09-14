import { getConnector } from "~~/server/connectors";
import { connectorIdParamsSchema } from "~~/server/schemas/integrations";
import { mintUserToken, probeStatus } from "~~/server/utils/connect";
import { throwConnectError } from "~~/server/utils/errors";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, connectorIdParamsSchema.parse);

  const connector = getConnector(id);
  const userId = await requireSessionUserId(event);

  try {
    const status = await probeStatus(connector, userId);
    const installationId = status.state === "connected" ? status.installationId : undefined;
    const token = await mintUserToken(connector, userId, installationId);
    const results = await connector.test.run(token);
    return { results };
  } catch (error) {
    throwConnectError(error);
  }
});
