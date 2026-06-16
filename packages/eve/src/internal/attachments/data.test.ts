import { describe, expect, it } from "vitest";

import { fileDataToBytes, getKnownByteLength } from "#internal/attachments/data.js";
import { encodeAttachmentRef } from "#internal/attachments/refs.js";

describe("fileDataToBytes", () => {
  it("passes Uint8Array payloads through as Buffer copies", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const buffer = await fileDataToBytes(bytes);

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer?.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  it("wraps ArrayBuffer payloads", async () => {
    const buffer = await fileDataToBytes(new ArrayBuffer(3));
    expect(buffer?.byteLength).toBe(3);
  });

  it("returns Buffer inputs verbatim", async () => {
    const source = Buffer.from("direct", "utf8");
    const buffer = await fileDataToBytes(source);
    expect(buffer).toBe(source);
  });

  it("decodes data-URL base64 payloads", async () => {
    const payload = "hello-from-data-url";
    const dataUrl = `data:text/plain;base64,${Buffer.from(payload, "utf8").toString("base64")}`;
    const buffer = await fileDataToBytes(dataUrl);
    expect(buffer?.toString("utf8")).toBe(payload);
  });

  it("decodes data-URL percent-encoded UTF-8 payloads", async () => {
    const buffer = await fileDataToBytes("data:text/plain,hello%20world");
    expect(buffer?.toString("utf8")).toBe("hello world");
  });

  it("returns null for malformed data URLs with no comma", async () => {
    expect(await fileDataToBytes("data:text/plain;base64")).toBeNull();
  });

  it("returns null for http/https URLs (provider fetches them)", async () => {
    expect(await fileDataToBytes("https://example.com/file.png")).toBeNull();
    expect(await fileDataToBytes("http://example.com/file.png")).toBeNull();
  });

  it("returns null for URL instances that are not data: URLs", async () => {
    expect(await fileDataToBytes(new URL("https://example.com/a.png"))).toBeNull();
  });

  it("decodes data: URL instances", async () => {
    const url = new URL("data:text/plain;base64,aGVsbG8=");
    const buffer = await fileDataToBytes(url);
    expect(buffer?.toString("utf8")).toBe("hello");
  });

  it("treats bare strings as base64 payloads (AI SDK DataContent contract)", async () => {
    const payload = "bare-base64";
    const base64 = Buffer.from(payload, "utf8").toString("base64");
    const buffer = await fileDataToBytes(base64);
    expect(buffer?.toString("utf8")).toBe(payload);
  });

  it("returns null for unsupported input types", async () => {
    expect(await fileDataToBytes(42)).toBeNull();
    expect(await fileDataToBytes(null)).toBeNull();
    expect(await fileDataToBytes({})).toBeNull();
  });

  it("returns null for eve-attachment: URLs (caller owns the resolver dispatch)", async () => {
    // The pure decoder deliberately does NOT reach into AsyncLocalStorage
    // to resolve refs. The harness attachment-staging layer owns that
    // dispatch explicitly so the ambient channel lookup happens in one
    // named place. Integration coverage for the full resolve path lives
    // in `harness/attachment-staging.integration.test.ts`.
    const url = encodeAttachmentRef({ params: { url: "https://files.slack.com/x" } });
    expect(await fileDataToBytes(url)).toBeNull();
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
    expect(getKnownByteLength("YQ==")).toBe(1); // one byte
    expect(getKnownByteLength("YWI=")).toBe(2); // two bytes
    expect(getKnownByteLength("YWJj")).toBe(3); // three bytes
  });

  it("returns 0 for empty strings", () => {
    expect(getKnownByteLength("")).toBe(0);
  });

  it("returns null for http/https URLs", () => {
    expect(getKnownByteLength("https://example.com/file")).toBeNull();
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
    // "héllo" → 5 characters, 6 UTF-8 bytes (é = C3 A9)
    expect(getKnownByteLength("data:text/plain,h%C3%A9llo")).toBe(6);
  });

  it("returns ref.size for eve-attachment: URLs when the adapter populated it", () => {
    const url = encodeAttachmentRef({
      params: { url: "https://files.slack.com/x" },
      size: 13319,
    });

    expect(getKnownByteLength(url)).toBe(13319);
  });

  it("returns null for eve-attachment: URLs without a size in the payload", () => {
    const url = encodeAttachmentRef({ params: { url: "u" } });
    expect(getKnownByteLength(url)).toBeNull();
  });
});
