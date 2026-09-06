import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const LINEAR_ROUTE_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/linear.ts": `import {
  linearChannel,
  verifyLinearRequest,
  type LinearVerifyOptions,
} from "eve/channels/linear";

const verifyOptions: LinearVerifyOptions = {
  webhookSecret: "test-secret",
};
const verifiedBody: Promise<string> = verifyLinearRequest(
  new Request("https://example.com/eve/v1/linear", { method: "POST" }),
  verifyOptions,
);
void verifiedBody;

export default linearChannel({});
`,
  },
  name: "linear-route-portability",
};
