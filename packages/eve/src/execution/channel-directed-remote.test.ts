import { describe, expect, it } from "vitest";

import {
  channelDirectedRemoteIdentity,
  normalizeChannelDirectedRemote,
} from "#execution/channel-directed-remote.js";

describe("normalizeChannelDirectedRemote", () => {
  it("stores a credential resolver id rather than resolved credentials", async () => {
    const resolver = Object.assign(() => ({}), { stepId: "credential-step" });
    const definition = {
      auth: async () => ({ headers: { authorization: "secret" } }),
      description: "Remote.",
      kind: "remote" as const,
      path: "/eve/v1/session/",
      url: "https://remote.example.com/",
    };
    Object.defineProperty(definition, "__eveResolveRemoteAgentCredentials", {
      value: resolver,
    });
    const remote = await normalizeChannelDirectedRemote(definition);

    expect(remote).toEqual({
      credentialsStepId: "credential-step",
      description: "Remote.",
      path: "/eve/v1/session",
      url: "https://remote.example.com",
    });
    expect(JSON.stringify(remote)).not.toContain("secret");
    expect(channelDirectedRemoteIdentity(remote)).toBe(
      "https://remote.example.com\n/eve/v1/session",
    );
  });

  it("rejects unregistered credentials", async () => {
    await expect(
      normalizeChannelDirectedRemote({
        auth: async () => ({ headers: { authorization: "secret" } }),
        description: "Remote.",
        kind: "remote",
        path: "/eve/v1/session",
        url: "https://remote.example.com",
      }),
    ).rejects.toThrow("credentials stay out of durable workflow state");
  });
});
