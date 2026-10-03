import { DefaultSandbox, defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

// A keyed tool session needs a provider that finds its sandbox again from the
// session id: Vercel Sandbox on Vercel, just-bash elsewhere. The default's local
// Docker and microsandbox providers cannot, so they are not used here.
export const environment = process.env.VERCEL
  ? DefaultSandbox.environment()
  : JustBashSandbox.environment({});

export default defineSandbox(async () => await environment.open());
