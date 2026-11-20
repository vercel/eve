import { describe, expect, it } from "vitest";

import { createPlatform } from "#platform/create.js";
import { currentPlatform, installPlatform } from "#platform/current.js";
import type { Platform } from "#platform/types.js";

describe("installed platform", () => {
  it("is what every platform accessor reads until it is uninstalled", () => {
    const base = createPlatform("vercel");
    const installed: Platform = {
      ...base,
      deployment: { ...base.deployment, deploymentId: () => "dpl_installed" },
    };

    const uninstall = installPlatform(installed);
    try {
      expect(currentPlatform()).toBe(installed);
      expect(currentPlatform().deployment.deploymentId()).toBe("dpl_installed");
    } finally {
      uninstall();
    }

    expect(currentPlatform()).not.toBe(installed);
  });
});
