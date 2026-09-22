import { braintrustEveInstrumentation, initLogger } from "braintrust";

export default braintrustEveInstrumentation({
  metadata: {
    app: "my-eve-agent", // Replace with your app name
  },
  setup: ({ agentName }) => {
    initLogger({
      projectName: agentName,
      apiKey: process.env.BRAINTRUST_API_KEY,
    });
  },
});
