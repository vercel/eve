import { braintrustEveInstrumentation, initLogger } from "braintrust";
import { defineState } from "eve/context";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation(
  braintrustEveInstrumentation({
    defineState,
    setup: ({ agentName }) => {
      initLogger({
        projectName: agentName,
        apiKey: process.env.BRAINTRUST_API_KEY,
      });
    },
  }) as Parameters<typeof defineInstrumentation>[0],
);
