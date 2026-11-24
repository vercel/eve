import { afterEach, describe, expect, it } from "vitest";

import { platformContext } from "#platform/context.js";
import { createVercelPlatformContext } from "#platform/vercel/context.js";
import { createProcessApp, installProcessApp, openSession, type App } from "#runtime/app.js";
import { endLifetime, registerCleanup } from "#runtime/lifetime.js";

let uninstall: (() => void) | undefined;

afterEach(() => uninstall?.());

describe("processApp", () => {
  it("is where platformContext() reads the platform from", () => {
    const platform = createVercelPlatformContext();
    const app = createProcessApp();
    app.platform = platform;
    uninstall = installProcessApp(app);

    expect(platformContext()).toBe(platform);
  });
});

describe("openSession", () => {
  it("gives a session a lifetime that ends on its own or before the app's cleanups", async () => {
    const ended: string[] = [];
    const { lifetime } = createProcessApp();
    const app = { lifetime } as App;
    registerCleanup(app.lifetime, () => void ended.push("app"));
    const finished = openSession(app, "session-alice");
    registerCleanup(finished.lifetime, () => void ended.push("session-alice"));
    const open = openSession(app, "session-bob");
    registerCleanup(open.lifetime, () => void ended.push("session-bob"));

    await endLifetime(finished.lifetime);
    await endLifetime(app.lifetime);

    expect(finished.id).toBe("session-alice");
    expect(ended).toEqual(["session-alice", "session-bob", "app"]);
  });
});
