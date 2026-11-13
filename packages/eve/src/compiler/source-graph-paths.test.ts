import { describe, expect, it } from "vitest";

import { validateProgrammaticLogicalPath } from "#compiler/source-graph-paths.js";

describe("validateProgrammaticLogicalPath", () => {
  it.each(["harness.ts", "harness.mjs", "harness/crm.ts"])(
    "accepts the harness slot %s",
    (path) => {
      expect(validateProgrammaticLogicalPath(path)).toBe(path);
    },
  );

  it.each(["harness/crm/extra.ts", "harnesses.ts"])("rejects %s", (path) => {
    expect(() => validateProgrammaticLogicalPath(path)).toThrow(
      "does not select an eve module slot",
    );
  });
});
