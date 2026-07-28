import { describe, expect, it, vi } from "vitest";

import { createDefaultSetupState } from "../state.js";
import { installChannelRegistryItems } from "./install-channel-registry-items.js";

function state(channels: Array<"slack" | "web">) {
  return {
    ...createDefaultSetupState(),
    projectPath: { kind: "resolved" as const, inPlace: true, path: "/project" },
    channelSelection: channels,
  };
}

describe("installChannelRegistryItems", () => {
  it("installs every selected channel item in selection order", async () => {
    const installItem = vi.fn(async () => {});
    const box = installChannelRegistryItems({ installItem });
    const setupState = state(["web", "slack"]);

    await box.perform({ state: setupState, input: undefined, sink: { write: () => {} } });

    expect(installItem.mock.calls).toEqual([
      ["/project", "channel/web"],
      ["/project", "channel/slack"],
    ]);
  });

  it("skips when no channels are selected", () => {
    const box = installChannelRegistryItems({ installItem: vi.fn(async () => {}) });
    expect(box.shouldRun?.(state([]))).toBe(false);
  });
});
