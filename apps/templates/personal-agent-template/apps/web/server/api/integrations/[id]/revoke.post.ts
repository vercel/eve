import { getConnector } from "~~/server/connectors";
import { connectorIdParamsSchema } from "~~/server/schemas/integrations";
import { probeStatus, revokeConnection } from "~~/server/utils/connect";
import { throwConnectError } from "~~/server/utils/errors";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, connectorIdParamsSchema.parse);

  const connector = getConnector(id);
  const userId = await requireSessionUserId(event);
  const status = await probeStatus(connector, userId);
  const installationId = status.state === "connected" ? status.installationId : undefined;

  try {
    await revokeConnection(connector, userId, installationId);
    return { ok: true };
  } catch (error) {
    throwConnectError(error);
  }
});
