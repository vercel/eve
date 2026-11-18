import { createHmac } from "node:crypto";

export function generateTotp(secret: string, now = Date.now(), period = 30, digits = 6): string {
  const key = decodeBase32(secret),
    counter = Math.floor(now / 1000 / period),
    buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", key).update(buffer).digest(),
    offset = hash[hash.length - 1] & 15,
    code = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}
function decodeBase32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    clean = value.toUpperCase().replace(/[\s=-]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid TOTP secret.");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  if (!bytes.length) throw new Error("Invalid TOTP secret.");
  return Buffer.from(bytes);
}
