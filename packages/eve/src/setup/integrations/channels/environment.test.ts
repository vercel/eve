import { describe, expect, it } from "vitest";

import { channelSetupEnvironment, describeChannelSetupEnvironment } from "./environment.js";

describe("channel setup environment", () => {
  it("keeps authenticated and unlinked as an available Vercel setup", () => {
    const environment = channelSetupEnvironment("authenticated", { kind: "unresolved" });
    expect(environment).toEqual({
      vercel: { kind: "available", project: { kind: "unresolved" } },
    });
    expect(describeChannelSetupEnvironment(environment)).toBe(
      "Found an authenticated Vercel account; this directory is not linked to a project.",
    );
  });

  it("reports the portable fallback when logged out", () => {
    const environment = channelSetupEnvironment("logged-out", { kind: "unresolved" });
    expect(environment).toEqual({ vercel: { kind: "unavailable", reason: "logged-out" } });
    expect(describeChannelSetupEnvironment(environment)).toBe(
      "No authenticated Vercel account found; using portable channel setup.",
    );
  });
});
