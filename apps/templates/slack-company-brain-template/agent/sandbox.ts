import { installCodeTooling } from "eve/extensions/code/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

// Vercel Sandbox's mutable network policy lets `lib/github.ts` keep GitHub
// tokens at the firewall instead of inside the sandbox. Locally it uses the
// linked Vercel project's credentials from `vercel env pull`.
export const environment = VercelSandbox.environment({
  prepare: (sandbox) => installCodeTooling(sandbox),
});

export default defineSandbox(() => environment.open());
