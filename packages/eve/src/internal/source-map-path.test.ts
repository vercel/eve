import { describe, expect, it } from "vitest";

import { isSourceMapUrl } from "./source-map-path.js";

describe("isSourceMapUrl", () => {
  it("distinguishes Windows absolute paths from URL schemes", () => {
    expect(isSourceMapUrl("C:\\repo\\app\\agent\\tool.ts")).toBe(false);
    expect(isSourceMapUrl("C:/repo/app/agent/tool.ts")).toBe(false);
    expect(isSourceMapUrl("/C:/repo/app/agent/tool.ts")).toBe(false);
    expect(isSourceMapUrl("\\\\server\\share\\agent\\tool.ts")).toBe(false);

    expect(isSourceMapUrl("file:///C:/repo/app/agent/tool.ts")).toBe(true);
    expect(isSourceMapUrl("node:fs")).toBe(true);
    expect(isSourceMapUrl("webpack://app/agent/tool.ts")).toBe(true);
  });
});
