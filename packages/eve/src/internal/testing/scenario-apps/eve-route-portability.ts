import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const EVE_ROUTE_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/eve.ts": `import { none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: none(),
  cors: {
    allowHeaders: ["authorization", "content-type"],
    exposeHeaders: ["x-request-id"],
    preflight: { statusCode: 204 },
  },
});
`,
  },
  name: "eve-route-portability",
};
