import { describe, expect, it } from "vitest";

import {
  concatBytes,
  decodeString,
  encodeString,
  fromBase64,
  latin1String,
  toBase64,
  toBase64Url,
  toHex,
  utf8ByteLength,
  utf8Bytes,
  utf8String,
} from "./bytes.js";

const TEXTS = ["", "abc", "héllo ✓ 🎉", "\ud83d", "a\u0000b", "x".repeat(70_000)];
const BYTES = [[], [0], [1, 2], [1, 2, 3], [255, 254, 253, 252], [0xc3, 0x28, 0x80]].map(
  (bytes) => new Uint8Array(bytes),
);
const ENCODINGS = [
  "utf8",
  "utf-8",
  "base64",
  "base64url",
  "hex",
  "latin1",
  "binary",
  "ascii",
  "utf16le",
  "ucs2",
] as const;

// Each helper stands in for a `Buffer` call on the browser path, so each must match it.
describe("eve's byte encodings, against Node's Buffer", () => {
  it("writes and measures UTF-8 as Buffer does, lone surrogates included", () => {
    for (const text of TEXTS) {
      expect(utf8Bytes(text)).toEqual(new Uint8Array(Buffer.from(text)));
      expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text));
    }
  });

  it("reads UTF-8, hex, base64 and latin1 as Buffer#toString does", () => {
    for (const bytes of BYTES) {
      const buffer = Buffer.from(bytes);
      expect(utf8String(bytes)).toBe(buffer.toString("utf8"));
      expect(toHex(bytes)).toBe(buffer.toString("hex"));
      expect(toBase64(bytes)).toBe(buffer.toString("base64"));
      expect(toBase64Url(bytes)).toBe(buffer.toString("base64url"));
      expect(latin1String(bytes)).toBe(buffer.toString("latin1"));
    }
  });

  it("decodes base64 and base64url, padded or not, as Buffer.from does", () => {
    for (const text of [
      "",
      "QQ",
      "QQ==",
      "QUI",
      "QUJD",
      "-_-_",
      "+/+/",
      "QU JD",
      "QQ==QQ",
      "@@QUJD",
    ]) {
      expect(fromBase64(text)).toEqual(new Uint8Array(Buffer.from(text, "base64")));
    }
  });

  it("encodes and decodes each of Buffer's string encodings as Buffer does", () => {
    for (const encoding of ENCODINGS) {
      for (const text of ["", "abc", "héllo ✓", "0aFf", "zz"]) {
        expect(encodeString(text, encoding)).toEqual(new Uint8Array(Buffer.from(text, encoding)));
      }
      for (const bytes of BYTES) {
        expect(decodeString(bytes, encoding)).toBe(Buffer.from(bytes).toString(encoding));
      }
    }
    expect(() => encodeString("a", "utf32")).toThrow("Unknown encoding: utf32");
  });

  it("joins chunks as Buffer.concat does", () => {
    expect(concatBytes(BYTES)).toEqual(new Uint8Array(Buffer.concat(BYTES)));
  });
});
