import type { CodeSandbox } from "#runtime/sandbox/code-sandbox-registry.js";
import { memorySandbox } from "#runtime/sandbox/memory-sandbox.js";

// A code agent's sandbox when it names none, in a browser: just-bash over an in-memory
// filesystem, whose files persist in the page's IndexedDB. `default-sandbox.ts` is the Node twin.

export function defaultCodeSandbox(): CodeSandbox {
  return memorySandbox();
}
