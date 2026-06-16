import { describe, expect, it, vi } from "vitest";

import { createNitroBundlerConfig } from "./nitro-bundler-config.js";

type BundlerLogHandler = (
  level: string,
  log: unknown,
  defaultHandler: (level: string, log: { readonly message: string }) => void,
) => void;

function getBundlerLogHandler(): BundlerLogHandler {
  const config = createNitroBundlerConfig([]);
  const onLog = config.onLog;

  if (typeof onLog !== "function") {
    throw new Error("Expected Nitro bundler config to install an onLog handler.");
  }

  return onLog as BundlerLogHandler;
}

describe("createNitroBundlerConfig", () => {
  it("suppresses vendored dependency warnings without hiding actionable logs", () => {
    const onLog = getBundlerLogHandler();
    const defaultHandler = vi.fn();

    onLog(
      "warn",
      {
        id: "/repo/node_modules/fixture/index.js",
        message: "dependency implementation detail",
      },
      defaultHandler,
    );
    onLog(
      "warn",
      {
        loc: {
          file: "/repo/packages/eve/.generated/compiled/gray-matter/index.js",
        },
        message: "generated compiled dependency implementation detail",
      },
      defaultHandler,
    );
    onLog(
      "warn",
      {
        id: "/repo/packages/eve/dist/src/compiled/gray-matter/index.js",
        message: "dist compiled dependency implementation detail",
      },
      defaultHandler,
    );
    onLog(
      "warn",
      {
        id: "/repo/packages/eve/src/internal/nitro/host/create-application-nitro.ts",
        message: "eve build warning",
      },
      defaultHandler,
    );
    onLog(
      "error",
      {
        id: "/repo/packages/eve/dist/src/compiled/gray-matter/index.js",
        message: "dependency build failure",
      },
      defaultHandler,
    );

    expect(defaultHandler).toHaveBeenCalledTimes(2);
    expect(defaultHandler).toHaveBeenNthCalledWith(
      1,
      "warn",
      expect.objectContaining({ message: "eve build warning" }),
    );
    expect(defaultHandler).toHaveBeenNthCalledWith(
      2,
      "error",
      expect.objectContaining({ message: "dependency build failure" }),
    );
  });
});
