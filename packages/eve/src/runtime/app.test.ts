import { describe, expect, it } from "vitest";

import { createProcessApp, openSession, type App } from "#runtime/app.js";
import { endLifetime, registerCleanup } from "#runtime/lifetime.js";

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
