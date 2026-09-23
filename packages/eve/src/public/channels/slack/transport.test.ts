import { describe, expect, it } from "vitest";

import { resolveSlackTransportOptions } from "#public/channels/slack/transport.js";

describe("resolveSlackTransportOptions", () => {
  it("leaves an omitted api undefined", () => {
    expect(resolveSlackTransportOptions(undefined)).toBeUndefined();
  });

  it("appends the trailing slash a directory base needs, and falls fileBaseUrl back", () => {
    expect(resolveSlackTransportOptions({ apiBaseUrl: "https://sim.example/api" })).toEqual({
      apiBaseUrl: "https://sim.example/api/",
      fetch: undefined,
      fileBaseUrl: "https://sim.example/api/",
    });
  });

  it("resolves a fileBaseUrl of its own", () => {
    expect(
      resolveSlackTransportOptions({
        apiBaseUrl: "https://sim.example/api/",
        fileBaseUrl: "https://sim.example/files",
      })?.fileBaseUrl,
    ).toBe("https://sim.example/files/");
  });

  it("names the option a base that is not an absolute http URL belongs to", () => {
    expect(() => resolveSlackTransportOptions({ apiBaseUrl: "/api/slack" })).toThrow(
      /api\.apiBaseUrl must be an absolute http or https URL/,
    );
    expect(() => resolveSlackTransportOptions({ fileBaseUrl: "ftp://sim.example/files" })).toThrow(
      /api\.fileBaseUrl must be an absolute http or https URL/,
    );
  });

  it("names the option a base carrying a query or fragment belongs to", () => {
    expect(() =>
      resolveSlackTransportOptions({ apiBaseUrl: "https://sim.example/api?key=abc" }),
    ).toThrow(/api\.apiBaseUrl must carry no query string or fragment/);
    expect(() =>
      resolveSlackTransportOptions({
        apiBaseUrl: "https://sim.example/api",
        fileBaseUrl: "https://sim.example/files#top",
      }),
    ).toThrow(/api\.fileBaseUrl must carry no query string or fragment/);
  });
});
