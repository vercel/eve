import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { EVE_HEALTH_ROUTE_PATH } from "#protocol/routes.js";
import { GET, HEAD, defineChannel } from "#public/definitions/channel.js";

const respond = async (): Promise<Response> =>
  Response.json({
    ok: true,
    status: "ready",
    workflowId: workflowEntryReference.workflowId,
  });

export default () =>
  defineChannel({
    routes: [GET(EVE_HEALTH_ROUTE_PATH, respond), HEAD(EVE_HEALTH_ROUTE_PATH, respond)],
  });
