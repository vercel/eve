import { describe, expect, it, vi } from "vitest";

import type { Sandbox as SdkSandbox } from "#compiled/@vercel/sandbox/index.js";
import {
  createVercelNetworkPolicySetter,
  createVercelSandboxHandle,
} from "#execution/sandbox/bindings/vercel-session.js";

function sandbox(): SdkSandbox {
  return {
    update: vi.fn(async () => {}),
  } as never;
}

describe("Vercel managed credential sessions", () => {
  it("allows authored policy replacement through the live session", async () => {
    const sdk = sandbox();

    await createVercelNetworkPolicySetter(sdk)("allow-all");

    expect(sdk.update).toHaveBeenCalledWith({ networkPolicy: "allow-all" });
  });

  it("rejects onSession policy replacement", async () => {
    const sdk = sandbox();
    const handle = createVercelSandboxHandle(
      sdk,
      "sandbox",
      {
        buildPolicy: () => "deny-all",
        clearedPolicy: "deny-all",
        rules: new Map(),
      },
      "deny-all",
    );

    await expect(handle.useSessionFn({ networkPolicy: "allow-all" })).rejects.toThrow(
      /onSession.*cannot replace/,
    );
    expect(sdk.update).not.toHaveBeenCalled();
  });
});
