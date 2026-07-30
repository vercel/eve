import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { photonIMessageChannel } from "#public/channels/photon/photonIMessageChannel.js";

function routes(channel: unknown): Array<{ method: string; path: string }> {
  if (!isCompiledChannel(channel)) throw new Error("Expected compiled channel.");
  return channel.routes.map((route) => ({ method: route.method, path: route.path }));
}

describe("photonIMessageChannel", () => {
  it("creates the default Photon webhook without eagerly resolving credentials", () => {
    const credentials = vi.fn(async () => ({
      projectId: "project-id",
      projectSecret: "project-secret",
    }));

    const channel = photonIMessageChannel({ credentials });

    expect(credentials).not.toHaveBeenCalled();
    expect(routes(channel)).toEqual([
      { method: "GET", path: "/eve/v1/photon" },
      { method: "POST", path: "/eve/v1/photon" },
    ]);
  });

  it("supports a custom webhook route", () => {
    const channel = photonIMessageChannel({
      credentials: async () => ({
        projectId: "project-id",
        projectSecret: "project-secret",
      }),
      route: "/hooks/imessage",
    });

    expect(routes(channel)).toEqual([
      { method: "GET", path: "/hooks/imessage" },
      { method: "POST", path: "/hooks/imessage" },
    ]);
  });
});
