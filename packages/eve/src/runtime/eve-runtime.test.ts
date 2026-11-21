import { afterEach, describe, expect, it } from "vitest";

import { platformContext } from "#platform/context.js";
import { createVercelPlatformContext } from "#platform/vercel/context.js";
import { createEveRuntime, installEveRuntime } from "#runtime/eve-runtime.js";

let uninstall: (() => void) | undefined;

afterEach(() => uninstall?.());

describe("EveRuntime", () => {
  it("is where platformContext() reads the platform from", () => {
    const platform = createVercelPlatformContext();
    const runtime = createEveRuntime();
    runtime.platform = platform;
    uninstall = installEveRuntime(runtime);

    expect(platformContext()).toBe(platform);
  });

  it("closes what boot registered once, newest first", async () => {
    const closed: string[] = [];
    const runtime = createEveRuntime();
    runtime.onClose(async () => void closed.push("world"));
    runtime.onClose(async () => void closed.push("instrumentation"));

    await runtime.close();
    await runtime.close();

    expect(closed).toEqual(["instrumentation", "world"]);
  });
});
