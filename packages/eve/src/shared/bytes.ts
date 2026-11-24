const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8");

export function utf8Bytes(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

export function utf8String(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes);
}

export function utf8ByteLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next < 0xe000) {
        length += 4;
        i++;
      } else length += 3;
    } else length += 3;
  }
  return length;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + (pad ? "==" : "");
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      alphabet[n >> 18]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + (pad ? "=" : "");
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  return encode(bytes, BASE64, true);
}

export function toBase64Url(bytes: Uint8Array): string {
  return encode(bytes, BASE64URL, false);
}

const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  DECODE[BASE64.charCodeAt(i)] = i;
  DECODE[BASE64URL.charCodeAt(i)] = i;
}

export function fromBase64(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let length = 0;
  let bits = 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 61) break;
    const value = code < 128 ? DECODE[code]! : -1;
    if (value < 0) continue;
    bits = (bits << 6) | value;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[length++] = (bits >> count) & 0xff;
    }
  }
  return out.subarray(0, length);
}

export function latin1String(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

export type StringEncoding =
  | "ascii"
  | "base64"
  | "base64url"
  | "binary"
  | "hex"
  | "latin1"
  | "ucs-2"
  | "ucs2"
  | "utf-16le"
  | "utf16le"
  | "utf-8"
  | "utf8";

function normalizeEncoding(encoding: string): string {
  const name = encoding.toLowerCase();
  if (name === "utf8" || name === "utf-8") return "utf8";
  if (name === "binary" || name === "latin1") return "latin1";
  if (name === "ucs2" || name === "ucs-2" || name === "utf16le" || name === "utf-16le")
    return "utf16le";
  if (name === "ascii" || name === "base64" || name === "base64url" || name === "hex") return name;
  throw new TypeError(`Unknown encoding: ${encoding}`);
}

export function encodeString(text: string, encoding: string): Uint8Array {
  switch (normalizeEncoding(encoding)) {
    case "utf8":
      return utf8Bytes(text);
    case "base64":
    case "base64url":
      return fromBase64(text);
    case "hex": {
      const out = new Uint8Array(text.length >> 1);
      let length = 0;
      for (; length < out.length; length++) {
        const byte = Number.parseInt(text.slice(length * 2, length * 2 + 2), 16);
        if (Number.isNaN(byte) || !/^[0-9a-f]{2}$/iu.test(text.slice(length * 2, length * 2 + 2)))
          break;
        out[length] = byte;
      }
      return out.subarray(0, length);
    }
    case "utf16le": {
      const out = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        out[i * 2] = code & 0xff;
        out[i * 2 + 1] = code >> 8;
      }
      return out;
    }
    default: {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      return out;
    }
  }
}

export function decodeString(bytes: Uint8Array, encoding: string): string {
  switch (normalizeEncoding(encoding)) {
    case "utf8":
      return utf8String(bytes);
    case "base64":
      return toBase64(bytes);
    case "base64url":
      return toBase64Url(bytes);
    case "hex":
      return toHex(bytes);
    case "latin1":
      return latin1String(bytes);
    case "ascii":
      return latin1String(bytes.map((byte) => byte & 0x7f));
    default: {
      let out = "";
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
      }
      return out;
    }
  }
}
