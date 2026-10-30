import { installAgentBrowser } from "@agent-browser/eve/sandbox";
import { installComputerUse } from "eve/extensions/computer-use/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

// Every chat gets its own Vercel Sandbox, during development too, in the project `eve link`
// connected. The headless Chrome and the Linux desktop run in it side by side. eve installs both
// once into the snapshot every sandbox starts from; the tools start each on first use, so a chat
// only pays for the one it uses.
export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installAgentBrowser(sandbox);
    await installComputerUse(sandbox);
  },
  resources: { vcpus: 4 },
});

export default defineSandbox(() =>
  environment.open({
    // The live view's relay; see agent/lib/live.ts. Ports apply when the sandbox is created.
    ports: [3600],
    // agent-browser caps stream frames at 1280×720 by default, which blurs the live view.
    env: {
      AGENT_BROWSER_STREAM_MAX_WIDTH: "2560",
      AGENT_BROWSER_STREAM_MAX_HEIGHT: "2560",
      AGENT_BROWSER_STREAM_QUALITY: "70",
    },
  }),
);
