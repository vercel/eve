import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";

import { buildSearchCommand, MAX_GREP_LINE_BYTES } from "#execution/sandbox/grep-search.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";

describe("grep command output channels", () => {
  it.each([0, 2])(
    "bounds diagnostics without consuming matches or changing exit %i",
    async (exitCode) => {
      const diagnostics = "warning\n".repeat(MAX_GREP_LINE_BYTES);
      const command = buildSearchCommand({
        contextLines: 0,
        glob: undefined,
        ignoreCase: false,
        limit: 1,
        literal: true,
        outputMode: "files_with_matches",
        path: "/workspace",
        pattern: "Alice",
      });
      const shell = new Bash();
      const result = await shell.exec(
        `rg() { printf 'notes.txt\\n'; printf '%s' ${shellQuote(diagnostics)} >&2; return ${exitCode}; }\n${command}`,
      );

      expect(result.stdout).toBe("notes.txt\n");
      expect(result.stderr).toBe(diagnostics.slice(0, MAX_GREP_LINE_BYTES));
      expect(result.exitCode).toBe(exitCode);
    },
  );
});
