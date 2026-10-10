import { describe, expect, it } from "vitest";

import { getKnownByteLength, readFileData } from "#internal/attachments/data.js";

function bytesOf(data: unknown): string | undefined {
  const read = readFileData(data);
  return read.kind === "bytes" ? read.bytes.toString("utf8") : undefined;
}

describe("readFileData", () => {
  it("reads typed arrays, ArrayBuffers, and Buffers as bytes", () => {
    const source = Buffer.from("direct", "utf8");
    expect(readFileData(source)).toEqual({ bytes: source, kind: "bytes" });
    expect(bytesOf(new Uint8Array([104, 105]))).toBe("hi");
    expect(bytesOf(new Uint8Array([104, 105]).buffer)).toBe("hi");
  });

  it("decodes base64 and percent-encoded data URLs, as strings or URLs", () => {
    expect(bytesOf(`data:text/plain;base64,${Buffer.from("hello").toString("base64")}`)).toBe(
      "hello",
    );
    expect(bytesOf("data:text/plain,hello%20world")).toBe("hello world");
    expect(bytesOf(new URL("data:text/plain;base64,aGVsbG8="))).toBe("hello");
  });

  it("treats bare strings as base64 payloads (AI SDK DataContent contract)", () => {
    expect(bytesOf(Buffer.from("bare-base64").toString("base64"))).toBe("bare-base64");
  });

  it("reads any other scheme as a link instead of decoding it as base64", () => {
    expect(readFileData("https://example.com/file.png")).toEqual({
      kind: "link",
      url: new URL("https://example.com/file.png"),
    });
    expect(readFileData("myapp-file:abc")).toEqual({
      kind: "link",
      url: new URL("myapp-file:abc"),
    });
    const url = new URL("https://example.com/a.png");
    expect(readFileData(url)).toEqual({ kind: "link", url });
  });

  it("refuses caller-supplied framework refs", () => {
    expect(readFileData("eve-sandbox:?path=/etc/passwd&size=1&type=text/plain")).toEqual({
      kind: "unreadable",
    });
    expect(readFileData("eve-url:https://example.com/a.png")).toEqual({ kind: "unreadable" });
  });

  it("reports unsupported shapes and malformed data URLs as unreadable", () => {
    for (const value of [42, null, {}, { 0: 1, 1: 2 }, "data:text/plain;base64"]) {
      expect(readFileData(value), JSON.stringify(value)).toEqual({ kind: "unreadable" });
    }
  });
});

describe("getKnownByteLength", () => {
  it("reports byteLength for typed arrays", () => {
    expect(getKnownByteLength(new Uint8Array(8))).toBe(8);
    expect(getKnownByteLength(new ArrayBuffer(4))).toBe(4);
    expect(getKnownByteLength(Buffer.from("hello", "utf8"))).toBe(5);
  });

  it("estimates base64 byte length from string length", () => {
    const payload = Buffer.from("hello world", "utf8").toString("base64");
    expect(getKnownByteLength(payload)).toBe(11);
  });

  it("estimates base64 byte length for data URLs", () => {
    const dataUrl = `data:text/plain;base64,${Buffer.from("hello", "utf8").toString("base64")}`;
    expect(getKnownByteLength(dataUrl)).toBe(5);
  });

  it("handles padded base64 strings accurately", () => {
    expect(getKnownByteLength("YQ==")).toBe(1);
    expect(getKnownByteLength("YWI=")).toBe(2);
    expect(getKnownByteLength("YWJj")).toBe(3);
  });

  it("returns 0 for empty strings", () => {
    expect(getKnownByteLength("")).toBe(0);
  });

  it("returns null for links, whatever their scheme", () => {
    expect(getKnownByteLength("https://example.com/file")).toBeNull();
    expect(getKnownByteLength("myapp-file:abc")).toBeNull();
    expect(getKnownByteLength(new URL("https://example.com/file"))).toBeNull();
  });

  it("returns null for unsupported input types", () => {
    expect(getKnownByteLength(42)).toBeNull();
    expect(getKnownByteLength(null)).toBeNull();
    expect(getKnownByteLength({})).toBeNull();
  });

  it("returns null for malformed data URLs", () => {
    expect(getKnownByteLength("data:text/plain;base64")).toBeNull();
  });

  it("computes byte length for percent-encoded data URLs by UTF-8 octet count", () => {
    expect(getKnownByteLength("data:text/plain,h%C3%A9llo")).toBe(6);
  });
});
