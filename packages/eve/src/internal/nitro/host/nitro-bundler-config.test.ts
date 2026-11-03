import { describe, expect, it, vi } from "vitest";

import { onNitroBundlerLog } from "./nitro-bundler-config.js";

describe("onNitroBundlerLog", () => {
  it.each([
    ["Nitro's unlabeled code-splitting group", { code: "MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME" }],
    ["vendored dependency code", { code: "EVAL", id: "/app/node_modules/pkg/index.js" }],
  ])("drops warnings about %s", (_label, log) => {
    const defaultHandler = vi.fn();
    onNitroBundlerLog("warn", log, defaultHandler);
    expect(defaultHandler).not.toHaveBeenCalled();
  });

  it("forwards warnings about authored code", () => {
    const defaultHandler = vi.fn();
    const log = { code: "EVAL", id: "/app/agent/tools/weather.ts" };
    onNitroBundlerLog("warn", log, defaultHandler);
    expect(defaultHandler).toHaveBeenCalledWith("warn", log);
  });
});
