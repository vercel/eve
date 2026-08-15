import { describe, expect, it } from "vitest";

import { InvalidArgumentError } from "#compiled/commander/index.js";

import { parseDevelopmentServerUrl } from "./url.js";

describe("parseDevelopmentServerUrl", () => {
  it("accepts https remote URLs, preserves query parameters, and strips the hash", () => {
    expect(parseDevelopmentServerUrl("https://my-app.vercel.app/path?token=1#frag")).toBe(
      "https://my-app.vercel.app/path?token=1",
    );
  });

  it("keeps http for loopback development hosts", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:2000", "http://[::1]:2000"]) {
      expect(parseDevelopmentServerUrl(url)).toBe(new URL(url).toString());
    }
  });

  it("rejects http for remote hosts so credentials can never target an http origin", () => {
    expect(() => parseDevelopmentServerUrl("http://my-app.vercel.app")).toThrow(
      InvalidArgumentError,
    );
    expect(() => parseDevelopmentServerUrl("http://my-app.vercel.app")).toThrow(/https/);
  });

  it("rejects non-http(s) protocols", () => {
    expect(() => parseDevelopmentServerUrl("ftp://example.com")).toThrow(InvalidArgumentError);
  });

  it("rejects malformed input", () => {
    expect(() => parseDevelopmentServerUrl("not a url")).toThrow(InvalidArgumentError);
  });
});
