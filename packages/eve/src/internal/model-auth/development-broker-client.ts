import { createHash } from "node:crypto";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { isLoopbackHostname } from "#shared/network-address.js";
import {
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
} from "#internal/workflow/development-world-protocol.js";
import { authJson } from "./vercel.js";
import {
  DEVELOPMENT_MODEL_CREDENTIAL_ROUTE,
  DEVELOPMENT_MODEL_REJECTED_HEADER,
  type DevelopmentModelCredential,
  type DevelopmentModelProvider,
} from "./development-broker-protocol.js";

export function developmentModelBrokerAvailable(): boolean {
  return (
    isEveDevEnvironment() &&
    Boolean(process.env.EVE_DEV_CONTROL_URL && process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV])
  );
}

export async function readDevelopmentModelCredential(
  provider: DevelopmentModelProvider,
  rejectedToken?: string,
  signal?: AbortSignal | null,
): Promise<DevelopmentModelCredential | undefined> {
  if (!developmentModelBrokerAvailable()) return undefined;
  const url = new URL(DEVELOPMENT_MODEL_CREDENTIAL_ROUTE, process.env.EVE_DEV_CONTROL_URL);
  if (!isLoopbackHostname(url.hostname) || url.protocol !== "http:" || url.username || url.password)
    throw new Error("The local model connection is unavailable. Restart eve dev.");
  url.searchParams.set("provider", provider);
  const headers: Record<string, string> = {
    [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV]!,
  };
  if (rejectedToken)
    headers[DEVELOPMENT_MODEL_REJECTED_HEADER] = createHash("sha256")
      .update(rejectedToken)
      .digest("hex");
  // The host may wait for the refresh lock and complete two OAuth requests.
  const value = await authJson(url.href, { headers, signal }, 256_000, 75_000);
  if (
    typeof value.token !== "string" ||
    !value.token ||
    !["api-key", "oauth", "oidc"].includes(String(value.kind))
  )
    throw new Error("The model connection is unavailable. Run /login to reconnect.");
  return {
    kind: value.kind as DevelopmentModelCredential["kind"],
    token: value.token,
    ...(typeof value.teamId === "string" && { teamId: value.teamId }),
    ...(typeof value.teamName === "string" && { teamName: value.teamName }),
    ...(typeof value.accountId === "string" && { accountId: value.accountId }),
    ...(typeof value.accountLabel === "string" && { accountLabel: value.accountLabel }),
  };
}
