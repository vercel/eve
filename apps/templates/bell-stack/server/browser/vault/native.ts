import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { generateTotp } from "./totp";

const boxSchema = z.object({
  iv: z.base64().refine((value) => Buffer.from(value, "base64").length === 12),
  tag: z.base64().refine((value) => Buffer.from(value, "base64").length === 16),
  ciphertext: z.base64().min(1),
});
const recordSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  label: z.string().min(1),
  allowedHosts: z.array(z.string().min(1).refine((value) => {
    try { return new URL(`https://${value}`).hostname === value; } catch { return false; }
  })).min(1),
  hasTotp: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  keyId: z.literal("local-v1"),
  wrappedKey: boxSchema,
  payload: boxSchema,
});
const storeSchema = z.object({ version: z.literal(1), records: z.array(recordSchema) })
  .refine(({ records }) => new Set(records.map(({ id }) => id)).size === records.length);
const payloadSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  totpSecret: z.string().optional(),
});

// The v1 file is trusted operator configuration: only credential fields are encrypted.
// Keep this reader for existing vaults; Bell does not expose vault management routes.
export class NativeVault {
  constructor(private path?: string, private masterKey?: Buffer) {}

  async list() {
    this.key();
    return (await this.read()).map((record) => ({
      provider: "native" as const,
      itemId: record.id,
      label: record.label,
      allowedHosts: record.allowedHosts,
      fields: { username: true, password: true, totp: record.hasTotp },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  async login(itemId: string) {
    const masterKey = this.key(),
      record = (await this.read()).find(({ id }) => id === itemId);
    if (!record) throw new Error("The selected local vault login was not found.");
    try {
      const dataKey = openBox(masterKey, record.wrappedKey),
        payload = payloadSchema.parse(JSON.parse(openBox(dataKey, record.payload).toString("utf8")));
      let totp: string | undefined;
      if (payload.totpSecret) {
        try { totp = generateTotp(payload.totpSecret); } catch {
          // Keep password login usable; the browser requests human help when OTP is unavailable.
        }
      }
      return {
        allowedHosts: record.allowedHosts,
        username: payload.username,
        password: payload.password,
        ...(totp ? { totp } : {}),
      };
    } catch {
      throw new Error("Could not decrypt the local vault login. Check the vault file and master key.");
    }
  }

  private async read() {
    try {
      const source = await readFile(this.path ?? process.env.BELL_VAULT_FILE ?? ".bell/vault.enc.json", "utf8");
      return storeSchema.parse(JSON.parse(source)).records;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw new Error("Could not read the local vault. Check its path, permissions, and v1 file format.");
    }
  }

  private key(): Buffer {
    const configured = process.env.BELL_VAULT_MASTER_KEY?.trim(),
      key = this.masterKey ?? (configured
        ? Buffer.from(configured, /^[a-f0-9]{64}$/i.test(configured) ? "hex" : "base64")
        : undefined);
    if (!key || key.length !== 32)
      throw new Error("Set BELL_VAULT_MASTER_KEY to a 32-byte base64 or 64-character hex key.");
    return key;
  }
}

export const nativeVault = new NativeVault();

function openBox(key: Buffer, box: z.infer<typeof boxSchema>) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.ciphertext, "base64")), decipher.final()]);
}
