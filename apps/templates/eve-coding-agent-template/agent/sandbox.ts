import { installCodeTooling } from "eve/extensions/code/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

// Vercel Sandbox provides the mutable network policy that keeps GitHub
// credentials at the firewall instead of inside the sandbox.
export const environment = VercelSandbox.environment({
  prepare: (sandbox) => installCodeTooling(sandbox),
});

export default defineSandbox(() => environment.open());
