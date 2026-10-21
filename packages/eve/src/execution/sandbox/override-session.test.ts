import { describe, expect, it } from "vitest";

import { overrideSandboxSession } from "#execution/sandbox/override-session.js";

class ProviderSession {
  label = "initial";
  readonly #secret = "private";

  reveal(): string {
    return this.#secret;
  }
}

describe("overrideSandboxSession", () => {
  it("forwards class methods, prototype, and assignments to the session", () => {
    const session = new ProviderSession();
    const view = overrideSandboxSession(session, { stop: async () => {} });

    expect(view.reveal()).toBe("private");
    expect(view).toBeInstanceOf(ProviderSession);
    view.label = "updated";
    expect(session.label).toBe("updated");
    expect(view.label).toBe("updated");
  });

  it("rejects assignments to overridden members", () => {
    const stop = async () => {};
    const view = overrideSandboxSession(new ProviderSession(), { stop });

    expect(() => {
      (view as { stop: unknown }).stop = null;
    }).toThrow(TypeError);
    expect(view.stop).toBe(stop);
  });
});
