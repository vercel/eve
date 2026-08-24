import { describe, expect, it } from "vitest";

import { createCompiledModuleMapIntegrityPlugin } from "#compiler/module-map-integrity-plugin.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";

describe("compiled module map integrity plugin", () => {
  it("rejects selected source changes after bundle preflight", async () => {
    let identity = "first";
    const plugin = createCompiledModuleMapIntegrityPlugin({
      expectedIdentity: identity,
      manifest: {} as CompiledAgentManifest,
      resolveIdentity: async () => identity,
    }) as {
      readonly buildEnd: () => Promise<void>;
      readonly buildStart: () => Promise<void>;
    };

    await plugin.buildStart();
    identity = "second";

    await expect(plugin.buildEnd()).rejects.toThrow('expected identity "first", received "second"');
  });
});
