import { describe, expect, it } from "vitest";

import { assertNoWorkflowDirectivePrologue } from "#internal/authored-directive-prologue.js";

describe("assertNoWorkflowDirectivePrologue", () => {
  it.each(["use step", "use workflow"])("rejects an authored %s directive", async (directive) => {
    await expect(
      assertNoWorkflowDirectivePrologue({
        filePath: "/app/agent/tools/example.ts",
        source: `'use strict';\n${JSON.stringify(directive)};\nexport const value = 1;\n`,
      }),
    ).rejects.toThrow(new RegExp(`actual .*${directive}.* directive`, "u"));
  });

  it("accepts comments and ordinary strings containing directive text", async () => {
    await expect(
      assertNoWorkflowDirectivePrologue({
        filePath: "/app/agent/tools/example.ts",
        source: [
          '// "use step" is documentation, not a directive.',
          'const message = "use workflow";',
          '"use step";',
          "export { message };",
          "",
        ].join("\n"),
      }),
    ).resolves.toBeUndefined();
  });
});
