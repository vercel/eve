import { Buffer } from "node:buffer";

/**
 * Builds an unsigned JWT (`alg: "none"`, fake signature) whose payload the
 * Codex auth helpers can decode. Test fixture only — no crypto involved.
 */
export function createUnsignedJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}
