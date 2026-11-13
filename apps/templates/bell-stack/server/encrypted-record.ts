import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function hash(value: string): string { return createHash("sha256").update(value).digest("base64url"); }

// Bind ciphertext to its purpose and owner so records cannot be swapped between users.
export function seal(value: unknown, key: Buffer, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function unseal<T>(value: string, key: Buffer, context: string): T {
  try {
    const [version, nonce, tag, body, extra] = value.split(".");
    if (version !== "v1" || !nonce || !tag || !body || extra !== undefined) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8")) as T;
  } catch {
    throw new Error("Credentials could not be decrypted.");
  }
}
