import { describe, expect, it } from "vitest";

import { resolveTuiTitle } from "./target.js";

describe("resolveTuiTitle", () => {
  it("humanizes the app folder name for a local server", () => {
    expect(
      resolveTuiTitle({
        name: undefined,
        target: {
          kind: "local",
          serverUrl: "http://127.0.0.1:3000",
          workspaceRoot: "/x/apps/fixtures/weather-agent",
        },
      }),
    ).toBe("Weather Agent");
  });

  it("uses the remote host when connecting to a URL", () => {
    expect(
      resolveTuiTitle({
        name: undefined,
        target: {
          kind: "remote",
          serverUrl: "https://example.com:8080",
          workspaceRoot: "/x",
        },
      }),
    ).toBe("example.com:8080");
  });

  it("prefers an explicit --name over both", () => {
    expect(
      resolveTuiTitle({
        name: "Custom",
        target: {
          kind: "remote",
          serverUrl: "https://example.com",
          workspaceRoot: "/x/weather-agent",
        },
      }),
    ).toBe("Custom");
  });
});
