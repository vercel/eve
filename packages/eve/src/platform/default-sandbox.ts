import { codeSandbox } from "#runtime/sandbox/code-sandbox.js";
import { type CodeSandbox } from "#runtime/sandbox/code-sandbox-registry.js";
import { JustBashSandbox } from "#sandbox/providers/just-bash.js";

// A code agent's sandbox when it names none, in Node: just-bash under `<cwd>/.eve/sandbox-cache`,
// which needs no daemon or account. `default-sandbox.web.ts` is the browser's; the package's
// `#platform/*` imports pick one by the `node` condition.

export function defaultCodeSandbox(): CodeSandbox {
  return codeSandbox(JustBashSandbox.environment({}));
}
