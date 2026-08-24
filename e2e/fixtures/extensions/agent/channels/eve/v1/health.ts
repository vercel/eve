import { defineChannel, GET, HEAD } from "eve/channels";

const respond = async (): Promise<Response> =>
  Response.json({
    ok: true,
    status: "ready",
    workflowId: "workflow//eve//workflowEntry",
  });

export default defineChannel({
  routes: [GET("/eve/v1/health", respond), HEAD("/eve/v1/health", respond)],
});
