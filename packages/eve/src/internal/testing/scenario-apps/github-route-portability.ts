import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const GITHUB_ROUTE_PORTABILITY_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/channels/github.ts": `import { githubChannel } from "eve/channels/github";

export default githubChannel({
  botName: "testbot",
});
`,
  },
  name: "github-route-portability",
};
