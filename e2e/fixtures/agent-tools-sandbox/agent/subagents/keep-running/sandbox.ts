import { DefaultSandbox, defineSandbox } from "eve/sandbox";

// Stops this subagent's own sandbox as soon as its session goes idle, so only
// its `keep_sandbox_running` tool can keep it running between turns.
export const environment = DefaultSandbox.environment({ idleTimeoutMs: 0 });

export default defineSandbox(() => environment.open());
