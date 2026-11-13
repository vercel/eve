import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

import { LOAD_SIGN_INS } from "./lib/bridge.js";
import { BRIDGE_PORT, browserEnv, REGION, SIGN_INS_DIR, signInsSnapshot } from "./lib/browser.js";

export const environment = VercelSandbox.environment({
  // Next to the Drive of saved sign-ins, which sandboxes can only mount in its region.
  region: REGION,
  env: { AGENT_BROWSER_REVALIDATION_KEY: agentBrowserRevalidationKey(), ...browserEnv() },
  prepare: async (sandbox) => {
    await installAgentBrowser(sandbox);
  },
});

// Only meetings that use the browser open a sandbox; the rest never start one.
export default defineSandbox(async () => {
  const signIns = await signInsSnapshot();
  const sandbox = await environment.open({
    ports: [BRIDGE_PORT],
    // Long enough for a meeting. The default 30 minutes would stop the shared screen mid-call.
    timeout: 2 * 60 * 60_000,
    ...(signIns && { mounts: { [SIGN_INS_DIR]: signIns } }),
  });
  await sandbox.run({ command: LOAD_SIGN_INS });
  return sandbox;
});
