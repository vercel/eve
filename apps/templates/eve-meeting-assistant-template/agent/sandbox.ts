import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

import { BRIDGE_PORT, browserEnv, REGION } from "./lib/browser.js";
import { copySignIns } from "./lib/sign-ins.js";

export const environment = VercelSandbox.environment({
  // Next to the sign-in sandbox that meetings copy saved sign-ins from.
  region: REGION,
  env: { AGENT_BROWSER_REVALIDATION_KEY: agentBrowserRevalidationKey(), ...browserEnv() },
  prepare: async (sandbox) => {
    await installAgentBrowser(sandbox);
  },
});

// Only meetings that use the browser open a sandbox; the rest never start one.
export default defineSandbox(async () => {
  const sandbox = await environment.open({
    ports: [BRIDGE_PORT],
    // Long enough for a meeting. The default 30 minutes would stop the shared screen mid-call.
    timeout: 2 * 60 * 60_000,
  });
  // The browser starts with the latest saved sign-ins. Without them it still
  // works, signed out, and eve can ask for a sign-in.
  await copySignIns(sandbox).catch((error: unknown) => {
    console.warn("Couldn't copy the saved browser sign-ins", error);
  });
  return sandbox;
});
