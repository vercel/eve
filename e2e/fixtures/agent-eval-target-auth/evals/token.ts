import { createHmac } from "node:crypto";

import { TOKEN } from "../agent/token-config.js";

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Mints a fixture session token that expires after `TOKEN.lifetimeSeconds`. */
export function mintToken(issuedAt = Math.floor(Date.now() / 1000)): string {
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    aud: TOKEN.audience,
    exp: issuedAt + TOKEN.lifetimeSeconds,
    iat: issuedAt,
    iss: TOKEN.issuer,
    sub: TOKEN.subject,
  })}`;
  return `${body}.${createHmac("sha256", TOKEN.secret).update(body).digest("base64url")}`;
}
