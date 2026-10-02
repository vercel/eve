import {
  ConnectError,
  ConnectorInstallationRequiredError,
  getToken,
  type ConnectTokenParams,
} from "@vercel/connect";
import type { SandboxSession } from "eve/sandbox";

import extension from "../extension.ts";
import { authenticateVercel } from "./credentials.ts";

type ExtensionConfig = typeof extension.config;
type GetToken = typeof getToken;

export async function authenticateTurn(
  config: ExtensionConfig,
  getSandbox: () => Promise<SandboxSession>,
  getConnectToken: GetToken = getToken,
): Promise<void> {
  if (config.vercel === undefined) return;
  const sandbox = await getSandbox();

  const token = await resolveToken(
    config.vercel.connector,
    { subject: { type: "app" } },
    getConnectToken,
  );
  await authenticateVercel(sandbox, {
    token,
    delivery: config.vercel.delivery,
    broker: config.broker,
  });
}

async function resolveToken(
  connector: string,
  params: ConnectTokenParams,
  getConnectToken: GetToken,
): Promise<string> {
  try {
    const token = await getConnectToken(connector, params);
    if (token.length === 0) throw new Error("Connect returned an empty token");
    return token;
  } catch (error) {
    const kind =
      error instanceof ConnectorInstallationRequiredError
        ? "connector installation is required"
        : error instanceof ConnectError
          ? "Connect rejected the token request"
          : "Connect token request failed";
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${kind} for ${JSON.stringify(connector)}: ${detail}`, { cause: error });
  }
}
