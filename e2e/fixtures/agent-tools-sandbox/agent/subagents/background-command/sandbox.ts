import { DefaultSandbox, defineSandbox } from "eve/sandbox";

// Stops this subagent's own sandbox as soon as its session goes idle, so only
// a command that `bash` left running can keep it running between turns, and
// then only while the command runs and for at most `bash`'s 30 minutes.
export const environment = DefaultSandbox.environment({ idleTimeoutMs: 0 });

export default defineSandbox(() => environment.open());
