import { codeSandboxWith, type CodeSandbox } from "#runtime/sandbox/code-sandbox.js";
import { MemorySandbox } from "#sandbox/providers/memory.js";

/**
 * A shell and files in memory for a code agent (`MemorySandbox`): pass it as
 * `eve.defaults({ sandbox })`. The files last as long as the process, and nothing reaches the
 * host.
 */
export function memorySandbox(): CodeSandbox {
  return codeSandboxWith(MemorySandbox.environment(), {
    appRoot: process.cwd(),
    // Nothing to build: a new session starts from an empty workspace.
    preparedArtifact: async () => null,
    revision: "code:memory",
  });
}
