/**
 * Example: wrap a framework default tool.
 *
 * This file shadows the framework `bash` tool because it lives at
 * `tools/bash.ts` — the compiler reads the filename slug to determine
 * which tool this entry replaces. It spreads the framework default from
 * `eve/tools/defaults` and overrides `execute` with a thin
 * wrapper that logs each invocation before delegating to the original.
 */

import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { bash } from "eve/tools/defaults";

export default defineTool({
  ...bash,
  needsApproval: once(),
  async execute(input, ctx) {
    const command =
      typeof input === "object" && input !== null && "command" in input
        ? String((input as { command: unknown }).command)
        : "<unknown>";
    console.error(`[weather-fixture bash] ${command}`);
    return bash.execute(input, ctx);
  },
});
