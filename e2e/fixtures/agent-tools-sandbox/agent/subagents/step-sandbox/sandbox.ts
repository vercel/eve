import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";
import { VercelSandbox } from "eve/sandbox/vercel";

// Vercel Sandbox when deployed, and just-bash elsewhere so the eval needs no
// container runtime.
export const environment = process.env.VERCEL
  ? VercelSandbox.environment()
  : JustBashSandbox.environment();

export default defineSandbox(() => environment.open());
