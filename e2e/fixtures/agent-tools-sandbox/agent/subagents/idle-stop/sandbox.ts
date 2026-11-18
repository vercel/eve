import { DefaultSandbox, defineSandbox } from "eve/sandbox";

// Stops this subagent's own sandbox as soon as its session goes idle. The
// fixture's shared environment keeps the default window, because its
// selector starts a server that other evals use.
export const environment = DefaultSandbox.environment({ idleTimeoutMs: 0 });

export default defineSandbox(() => environment.open());
