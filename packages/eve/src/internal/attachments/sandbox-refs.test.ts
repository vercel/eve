import { describe, expect, it } from "vitest";

import {
  decodeSandboxRef,
  encodeSandboxRef,
  isSandboxRefUrl,
  SANDBOX_URL_SCHEME,
  type SandboxRef,
} from "#internal/attachments/sandbox-refs.js";

describe("encodeSandboxRef", () => {
  it("builds an eve-sandbox: URL carrying path, size, and media type as query params", () => {
    const url = encodeSandboxRef({
      mediaType: "image/png",
      path: "/workspace/attachments/abcdef0123456789/chart.png",
      size: 1024,
    });

    expect(url.protocol).toBe(SANDBOX_URL_SCHEME);
    expect(url.searchParams.get("path")).toBe("/workspace/attachments/abcdef0123456789/chart.png");
    expect(url.searchParams.get("size")).toBe("1024");
    expect(url.searchParams.get("type")).toBe("image/png");
  });

  it("percent-encodes path and media type so the URL round-trips through new URL()", () => {
    const url = encodeSandboxRef({
      mediaType: "application/json; charset=utf-8",
      path: "/workspace/attachments/abc/weird name & symbols.txt",
      size: 7,
    });

    const roundTripped = new URL(url.toString());
    expect(roundTripped.searchParams.get("path")).toBe(
      "/workspace/attachments/abc/weird name & symbols.txt",
    );
    expect(roundTripped.searchParams.get("type")).toBe("application/json; charset=utf-8");
  });

  it("accepts size = 0 (empty file)", () => {
    const url = encodeSandboxRef({
      mediaType: "text/plain",
      path: "/workspace/attachments/empty/zero.txt",
      size: 0,
    });
    expect(url.searchParams.get("size")).toBe("0");
  });

  it("throws RangeError when path is empty", () => {
    expect(() => encodeSandboxRef({ mediaType: "text/plain", path: "", size: 1 })).toThrow(
      RangeError,
    );
  });

  it("throws RangeError when size is negative", () => {
    expect(() => encodeSandboxRef({ mediaType: "text/plain", path: "/a", size: -1 })).toThrow(
      RangeError,
    );
  });

  it("throws RangeError when size is not an integer", () => {
    expect(() => encodeSandboxRef({ mediaType: "text/plain", path: "/a", size: 1.5 })).toThrow(
      RangeError,
    );
  });

  it("throws RangeError when mediaType is empty", () => {
    expect(() => encodeSandboxRef({ mediaType: "", path: "/a", size: 1 })).toThrow(RangeError);
  });
});

describe("decodeSandboxRef", () => {
  it("round-trips every field end-to-end via a URL instance", () => {
    const original: SandboxRef = {
      mediaType: "image/png",
      path: "/vercel/sandbox/workspace/attachments/abc123/diagram.png",
      size: 524288,
    };
    const decoded = decodeSandboxRef(encodeSandboxRef(original));
    expect(decoded).toEqual(original);
  });

  it("round-trips via a string representation", () => {
    const original: SandboxRef = {
      mediaType: "text/csv",
      path: "/workspace/attachments/abc/report.csv",
      size: 4096,
    };
    const decoded = decodeSandboxRef(encodeSandboxRef(original).toString());
    expect(decoded).toEqual(original);
  });

  it("throws when the URL scheme is not eve-sandbox:", () => {
    const wrongSchemeUrl = new URL("https://example.com/?path=/a&size=1&type=text/plain");
    expect(() => decodeSandboxRef(wrongSchemeUrl)).toThrow(/must use scheme "eve-sandbox:"/);
  });

  it("throws when path is missing", () => {
    const url = new URL(SANDBOX_URL_SCHEME);
    url.searchParams.set("size", "1");
    url.searchParams.set("type", "text/plain");
    expect(() => decodeSandboxRef(url)).toThrow(/missing the required "path"/);
  });

  it("throws when size is missing", () => {
    const url = new URL(SANDBOX_URL_SCHEME);
    url.searchParams.set("path", "/a");
    url.searchParams.set("type", "text/plain");
    expect(() => decodeSandboxRef(url)).toThrow(/missing the required "size"/);
  });

  it("throws when type is missing", () => {
    const url = new URL(SANDBOX_URL_SCHEME);
    url.searchParams.set("path", "/a");
    url.searchParams.set("size", "1");
    expect(() => decodeSandboxRef(url)).toThrow(/missing the required "type"/);
  });

  it("throws when size is not a non-negative integer", () => {
    const url = new URL(SANDBOX_URL_SCHEME);
    url.searchParams.set("path", "/a");
    url.searchParams.set("size", "nope");
    url.searchParams.set("type", "text/plain");
    expect(() => decodeSandboxRef(url)).toThrow(/must be a non-negative integer/);
  });
});

describe("isSandboxRefUrl", () => {
  it("returns true for a URL with the eve-sandbox: scheme", () => {
    const url = encodeSandboxRef({
      mediaType: "text/plain",
      path: "/a",
      size: 1,
    });
    expect(isSandboxRefUrl(url)).toBe(true);
  });

  it("returns false for a URL with a different scheme", () => {
    expect(isSandboxRefUrl(new URL("eve-attachment:?v=1&p=e30"))).toBe(false);
    expect(isSandboxRefUrl(new URL("https://example.com/a"))).toBe(false);
    expect(isSandboxRefUrl(new URL("data:text/plain;base64,Zm9v"))).toBe(false);
  });

  it("returns false for strings (even valid eve-sandbox: strings)", () => {
    // Matches the existing refs.ts convention: only URL instances are
    // considered refs. The staging layer checks `data instanceof URL`
    // before dispatching.
    expect(isSandboxRefUrl("eve-sandbox:?path=/a&size=1&type=text/plain")).toBe(false);
  });

  it("returns false for null and non-URL objects", () => {
    expect(isSandboxRefUrl(null)).toBe(false);
    expect(isSandboxRefUrl(undefined)).toBe(false);
    expect(isSandboxRefUrl({})).toBe(false);
    expect(isSandboxRefUrl(Buffer.from("x"))).toBe(false);
  });
});
