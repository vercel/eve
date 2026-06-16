import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const TWILIO_ROUTE_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/twilio.ts": `import { twilioChannel } from "eve/channels/twilio";

export default twilioChannel({
  allowFrom: "+15551234567",
});
`,
  },
  name: "twilio-route-portability",
};
