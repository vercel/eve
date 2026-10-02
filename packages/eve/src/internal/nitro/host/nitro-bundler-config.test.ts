import { describe, expect, it, vi } from "vitest";

import { createNitroBundlerConfig } from "./nitro-bundler-config.js";

type OnLog = (
  level: string,
  log: unknown,
  defaultHandler: (level: string, log: unknown) => void,
) => void;

describe("createNitroBundlerConfig", () => {
  it.each([
    ["Nitro's unlabeled code-splitting group", { code: "MISSING_CODE_SPLITTING_GROUP_DEBUG_NAME" }],
    ["vendored dependency code", { code: "EVAL", id: "/app/node_modules/pkg/index.js" }],
  ])("drops warnings about %s", (_label, log) => {
    const onLog = createNitroBundlerConfig([]).onLog as OnLog;
    const defaultHandler = vi.fn();
    onLog("warn", log, defaultHandler);
    expect(defaultHandler).not.toHaveBeenCalled();
  });

  it("forwards warnings about authored code", () => {
    const onLog = createNitroBundlerConfig([]).onLog as OnLog;
    const defaultHandler = vi.fn();
    const log = { code: "EVAL", id: "/app/agent/tools/weather.ts" };
    onLog("warn", log, defaultHandler);
    expect(defaultHandler).toHaveBeenCalledWith("warn", log);
  });
});
