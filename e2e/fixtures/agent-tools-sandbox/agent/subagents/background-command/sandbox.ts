import { DefaultSandbox, defineSandbox } from "eve/sandbox";

// Stops this subagent's own sandbox as soon as its session goes idle, so only
// a command that `bash` left running can keep it running between turns. The
// short `backgroundTimeoutMs` bounds what a failed run leaves running.
export const environment = DefaultSandbox.environment({
  backgroundTimeoutMs: 5 * 60_000,
  idleTimeoutMs: 0,
});

export default defineSandbox(() => environment.open());
