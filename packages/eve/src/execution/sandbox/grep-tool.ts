import { executeGrepSearch, type GrepSearchResult } from "#execution/sandbox/grep-search.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import type { GrepToolInput } from "#tools/provided/grep.js";
export type GrepInput = GrepToolInput;
export type GrepResult = GrepSearchResult;
export function executeGrepOnSandbox(
  sandbox: SandboxSession,
  input: GrepInput,
): Promise<GrepResult> {
  return executeGrepSearch(input, sandbox);
}
