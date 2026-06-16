import { describe, expect, it } from "vitest";

import { parseProjectName, validateProjectName } from "./project-name.js";

describe("project name", () => {
  it("normalizes a valid project name", () => {
    expect(parseProjectName("  my-agent  ")).toBe("my-agent");
  });

  it.each(["", ".", "..", "../escape", "nested/agent", "My-Agent", "my agent"])(
    "rejects %j as a project name",
    (name) => {
      expect(validateProjectName(name)).toBeDefined();
      expect(() => parseProjectName(name)).toThrow();
    },
  );
});
