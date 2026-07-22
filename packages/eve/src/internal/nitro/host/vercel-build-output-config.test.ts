import { describe, expect, it } from "vitest";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { createEveVercelOptions } from "#internal/nitro/host/vercel-build-output-config.js";

describe("createEveVercelOptions", () => {
  it("returns undefined when the Vercel build output is disabled", () => {
    expect(createEveVercelOptions(false)).toBeUndefined();
  });

  it("emits both framework slug and version so the proxy keeps the framework object", () => {
    expect(createEveVercelOptions(true)).toEqual({
      config: {
        version: 3,
        framework: {
          slug: EVE_PACKAGE_NAME,
          version: resolveInstalledPackageInfo().version,
        },
      },
    });
  });
});
