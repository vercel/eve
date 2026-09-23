import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("the fetch resolveSlackTransportOptions returns", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Records which transport a URL travelled on. */
  function transports(api: Parameters<typeof resolveSlackTransportOptions>[0]) {
    const seen: string[] = [];
    const supplied = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      seen.push(`supplied ${String(input instanceof Request ? input.url : input)}`);
      return new Response("");
    });
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      seen.push(`global ${String(input instanceof Request ? input.url : input)}`);
      return new Response("");
    });
    const resolved = resolveSlackTransportOptions({ ...api, fetch: supplied as never });
    return { seen, fetch: resolved?.fetch };
  }

  it("carries a call to the configured api base", async () => {
    const { seen, fetch: confined } = transports({ apiBaseUrl: "https://sim.example/api" });
    await confined?.("https://sim.example/api/chat.postMessage");
    expect(seen).toEqual(["supplied https://sim.example/api/chat.postMessage"]);
  });

  it("leaves a host the stand-in names on the global fetch", async () => {
    const { seen, fetch: confined } = transports({ apiBaseUrl: "https://sim.example/api" });
    // The `upload_url` from `files.getUploadURLExternal` and a `url_private` download
    // are addressed by data, so a credential-attaching wrapper must not see them.
    await confined?.("https://files.slack.com/upload/abc");
    await confined?.(new Request("https://attacker.example/steal"));
    expect(seen).toEqual([
      "global https://files.slack.com/upload/abc",
      "global https://attacker.example/steal",
    ]);
  });

  it("carries a call to a fileBaseUrl on another origin", async () => {
    const { seen, fetch: confined } = transports({
      apiBaseUrl: "https://sim.example/api",
      fileBaseUrl: "https://files.sim.example/",
    });
    await confined?.("https://files.sim.example/F123/report.csv");
    expect(seen).toEqual(["supplied https://files.sim.example/F123/report.csv"]);
  });

  it("carries every Slack host when no base is configured", async () => {
    const { seen, fetch: confined } = transports({});
    await confined?.("https://slack.com/api/chat.postMessage");
    await confined?.("https://files.slack.com/a/b/report.csv");
    expect(seen).toEqual([
      "supplied https://slack.com/api/chat.postMessage",
      "supplied https://files.slack.com/a/b/report.csv",
    ]);
  });

  it("stays undefined when no fetch is supplied", () => {
    expect(
      resolveSlackTransportOptions({ apiBaseUrl: "https://sim.example/api" })?.fetch,
    ).toBeUndefined();
  });
});

describe("resolving an already-resolved value", () => {
  it("returns it unchanged rather than re-wrapping", () => {
    const once = resolveSlackTransportOptions({ apiBaseUrl: "https://sim.example/api" });
    expect(resolveSlackTransportOptions(once)).toBe(once);
  });

  it("leaves the confinement single-layered", async () => {
    const seen: string[] = [];
    const supplied = async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      return new Response("");
    };
    const once = resolveSlackTransportOptions({
      apiBaseUrl: "https://sim.example/api",
      fetch: supplied as never,
    });
    const twice = resolveSlackTransportOptions(once);
    expect(twice?.fetch).toBe(once?.fetch);
    await twice?.fetch?.("https://sim.example/api/chat.postMessage");
    expect(seen).toEqual(["https://sim.example/api/chat.postMessage"]);
  });
});
