import { afterEach, describe, expect, it, vi } from "vitest";

import { createWebhook, sleep } from "#internal/workflow-bundle/workflow-core-shim.js";

const WORKFLOW_SLEEP = Symbol.for("WORKFLOW_SLEEP");
const workflowGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
const originalSleep = workflowGlobal[WORKFLOW_SLEEP];

afterEach(() => {
  if (originalSleep === undefined) {
    delete workflowGlobal[WORKFLOW_SLEEP];
  } else {
    workflowGlobal[WORKFLOW_SLEEP] = originalSleep;
  }
});

describe("workflow core shim sleep", () => {
  it("forwards durable durations to the workflow VM implementation", async () => {
    const sleepImpl = vi.fn(async () => {});
    workflowGlobal[WORKFLOW_SLEEP] = sleepImpl;

    await expect(sleep(2_500)).resolves.toBeUndefined();
    expect(sleepImpl).toHaveBeenCalledExactlyOnceWith(2_500);
  });

  it("rejects use outside a workflow body", () => {
    delete workflowGlobal[WORKFLOW_SLEEP];

    expect(() => sleep(2_500)).toThrow("`sleep()` can only be called inside a workflow function");
  });
});

describe("workflow core shim webhooks", () => {
  afterEach(() => vi.unstubAllGlobals());

  function installHook() {
    const hook = { token: "generated/token", getConflict: vi.fn() };
    const create = vi.fn(() => hook);
    vi.stubGlobal(Symbol.for("WORKFLOW_CREATE_HOOK"), create);
    vi.stubGlobal(Symbol.for("WORKFLOW_CONTEXT"), { url: "https://agent.example" });
    return { create, hook };
  }

  it("creates a publicly resumable webhook with an encoded generated token", () => {
    const { create, hook } = installHook();
    const webhook = createWebhook();
    expect(webhook).toBe(hook);
    expect(webhook.url).toBe(
      "https://agent.example/.well-known/workflow/v1/webhook/generated%2Ftoken",
    );
    expect(create).toHaveBeenCalledExactlyOnceWith({ isWebhook: true, metadata: undefined });
  });

  it.each(["manual", new Response("accepted", { status: 202 })])(
    "preserves the webhook response mode as hook metadata",
    (respondWith) => {
      const { create } = installHook();
      createWebhook({ respondWith });
      expect(create).toHaveBeenCalledExactlyOnceWith({
        isWebhook: true,
        metadata: { respondWith },
      });
    },
  );

  it("rejects authored tokens before creating a public hook", () => {
    const { create } = installHook();
    expect(() => createWebhook({ token: "predictable" })).toThrow("does not accept a `token`");
    expect(create).not.toHaveBeenCalled();
  });
});
