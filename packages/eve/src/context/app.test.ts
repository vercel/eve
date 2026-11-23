import { describe, expect, it } from "vitest";

import { appOf, bindApp } from "#context/app.js";
import { ContextContainer } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import type { App } from "#runtime/app.js";

describe("the app in a turn's context", () => {
  it("stays out of the serialized context and across a step's context scope", () => {
    const app = { platform: {} } as App;
    const ctx = new ContextContainer();
    bindApp(ctx, app);

    expect(Object.keys(serializeContext(ctx))).not.toContain("eve.app");
    ctx.clearVirtualContext();
    expect(appOf(ctx)).toBe(app);
  });
});
