import { describe, expect, it } from "vitest";

import { installShutdownSignal, waitForShutdownSignal } from "#cli/shutdown.js";

describe("installShutdownSignal", () => {
  it("removes its process listeners when disposed", () => {
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    const lifecycle = installShutdownSignal();

    expect(process.listenerCount("SIGINT")).toBe(sigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm + 1);
    lifecycle.requestStop();
    lifecycle.requestStop();
    lifecycle.dispose();

    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
  });

  it("removes listeners when an owned server stops itself", async () => {
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");

    await waitForShutdownSignal({ close: async () => {}, wait: async () => {} });

    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
  });
});
