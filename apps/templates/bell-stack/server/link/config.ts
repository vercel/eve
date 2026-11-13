import { unseal as decryptRecord } from "../encrypted-record";

export class LinkSetupError extends Error {
  constructor(readonly reason: "missing_configuration" | "invalid_configuration" | "credentials_unreadable", readonly setting?: string) {
    super(reason === "credentials_unreadable"
      ? "Link credentials could not be decrypted. Check the server encryption key."
      : `Check ${setting} in the server configuration.`);
    this.name = "LinkSetupError";
  }
}

export interface LinkConfig {
  databaseUrl: string;
  origin: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  publishableKey: string;
  encryptionKey: Buffer;
}

export function linkConfig(): LinkConfig {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new LinkSetupError("missing_configuration", name);
    return value;
  };
  const origin = required("BELL_PUBLIC_URL");
  let url: URL;
  try { url = new URL(origin); } catch { throw new LinkSetupError("invalid_configuration", "BELL_PUBLIC_URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== origin || (url.protocol !== "https:" && !(loopback && url.protocol === "http:")))
    throw new LinkSetupError("invalid_configuration", "BELL_PUBLIC_URL");
  const encodedKey = required("LINK_TOKEN_ENCRYPTION_KEY");
  const encryptionKey = Buffer.from(encodedKey, "base64");
  if (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== encodedKey)
    throw new LinkSetupError("invalid_configuration", "LINK_TOKEN_ENCRYPTION_KEY");
  return {
    databaseUrl: required("DATABASE_URL"), origin,
    redirectUri: `${origin}/api/link/oauth/callback`,
    clientId: required("LINK_CLIENT_ID"), clientSecret: required("LINK_CLIENT_SECRET"),
    publishableKey: required("STRIPE_PUBLISHABLE_KEY"), encryptionKey,
  };
}

export { hash, seal } from "../encrypted-record";
export function unseal<T>(value: string, key: Buffer, context: string): T {
  try { return decryptRecord<T>(value, key, context); }
  catch { throw new LinkSetupError("credentials_unreadable", "LINK_TOKEN_ENCRYPTION_KEY"); }
}
