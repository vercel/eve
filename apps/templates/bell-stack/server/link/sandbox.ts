import { createHash, randomUUID } from "node:crypto";
import type { ConnectionPrincipal } from "eve/connections";

const requests = new Set<string>();
const run = randomUUID();
export const isLinkSandbox = () => process.env.LINK_SANDBOX === "1";

export function sandboxToken(principal: ConnectionPrincipal): { token: string } {
  const token = process.env.LINK_SANDBOX_ACCESS_TOKEN?.trim();
  if (principal.type !== "user" || principal.issuer !== "linq"
    || !principal.id.startsWith("linq:") || principal.id !== process.env.LINK_SANDBOX_PRINCIPAL_ID?.trim())
    throw new Error("This sender is not the configured Link sandbox operator.");
  if (!token) throw new Error("Inject LINK_SANDBOX_ACCESS_TOKEN into the sandbox process.");
  return { token };
}

export function sandboxPurchase<T extends { test: boolean; idempotency_key?: string }>(input: T): T {
  if (!isLinkSandbox()) return input;
  const key = createHash("sha256").update(input.idempotency_key ?? randomUUID()).digest("hex");
  return { ...input, test: true, idempotency_key: `${run}:${key}` };
}

export function rememberSandboxRequest(id: string): void {
  if (isLinkSandbox()) requests.add(id);
}

export function isSandboxRequest(id: string): boolean {
  return !isLinkSandbox() || requests.has(id);
}

export function assertSandboxRequest(id: string): void {
  if (!isSandboxRequest(id)) throw new Error("Sandbox access is limited to test requests created by this process. Do not retry an uncertain purchase after restarting.");
}
