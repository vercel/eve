import { connectors } from "~~/server/connectors";
import { probeStatus } from "~~/server/utils/connect";
import { requireSessionUserId } from "~~/server/utils/session";

export default defineEventHandler(async (event) => {
  const userId = await requireSessionUserId(event);

  const summaries = await Promise.all(
    connectors.map(async (connector) => {
      const status = await probeStatus(connector, userId);

      return {
        id: connector.id,
        name: connector.name,
        description: connector.description,
        icon: connector.icon,
        connectorUid: connector.connector,
        connectionName: connector.connectionName,
        testLabel: connector.test.label,
        status,
        connectedAs: status.state === "connected" ? status.label : undefined,
      };
    }),
  );

  return summaries;
});
