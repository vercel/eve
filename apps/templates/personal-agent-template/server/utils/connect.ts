import type { ConnectorDef, ConnectorStatus } from "#shared/types/connector";
import { CONNECT_USER_ISSUER } from "#shared/connect";
import type { ConnectTokenSubject } from "@vercel/connect";
import {
  ConnectError,
  ConnectorInstallationRequiredError,
  getToken,
  getTokenResponse,
  NoValidTokenError,
  revokeToken,
  startAuthorization,
  UserAuthorizationRequiredError,
} from "@vercel/connect";

function userSubjects(userId: string): ConnectTokenSubject[] {
  const subjects: ConnectTokenSubject[] = [
    { type: "user", id: userId, issuer: CONNECT_USER_ISSUER },
    { type: "user", id: userId },
  ];

  const authUrl = process.env.BETTER_AUTH_URL?.trim();
  if (authUrl) {
    subjects.push({ type: "user", id: userId, issuer: authUrl });
  }

  return subjects;
}

function tokenParams(def: ConnectorDef, subject: ConnectTokenSubject, installationId?: string) {
  const params: { subject: ConnectTokenSubject; scopes?: string[]; installationId?: string } = {
    subject,
  };
  if (def.scopes.length) params.scopes = [...def.scopes];
  if (installationId) params.installationId = installationId;
  return params;
}

function isMissingGrantError(error: unknown) {
  return error instanceof UserAuthorizationRequiredError || error instanceof NoValidTokenError;
}

function connectCreateCommand(def: ConnectorDef) {
  if (def.id === "github") {
    return "vercel connect create github --name personal-agent";
  }

  return "vercel connect create mcp.linear.app --name linear";
}

function formatSetupHint(def: ConnectorDef, reason: "missing" | "not_linked") {
  if (reason === "missing") {
    return [
      "Create the connector, then attach it to this project:",
      connectCreateCommand(def),
      `vercel connect attach ${def.connector}`,
      "Update the connector UID in server/connectors.ts if it differs from `vercel connect list`.",
    ].join("\n");
  }

  return `Run: vercel connect attach ${def.connector}`;
}

function mapConnectError(error: unknown, def: ConnectorDef): ConnectorStatus {
  if (isMissingGrantError(error)) {
    return { state: "not_connected" };
  }

  if (error instanceof ConnectorInstallationRequiredError) {
    return { state: "installation_required" };
  }

  if (error instanceof ConnectError) {
    const code = error.code?.toLowerCase();
    const message = error.message.toLowerCase();

    if (
      code === "connector_not_found" ||
      code === "client_not_found" ||
      message.includes("connector not found") ||
      message.includes("no connector found")
    ) {
      return {
        state: "setup_required",
        message: `Connector "${def.connector}" is not registered on your Vercel team.`,
        hint: formatSetupHint(def, "missing"),
      };
    }

    if (
      code === "client_not_linked_to_project" ||
      code === "client_not_enabled_for_environment" ||
      message.includes("not linked") ||
      message.includes("not enabled for environment")
    ) {
      return {
        state: "setup_required",
        message: `Connector "${def.connector}" is not attached to this project.`,
        hint: formatSetupHint(def, "not_linked"),
      };
    }

    return { state: "error", message: error.message };
  }

  if (error instanceof Error) {
    return { state: "error", message: error.message };
  }

  return { state: "error", message: "Unknown Connect error" };
}

async function withUserTokenResponse(def: ConnectorDef, userId: string, installationId?: string) {
  let lastError: unknown;

  for (const subject of userSubjects(userId)) {
    try {
      return await getTokenResponse(def.connector, tokenParams(def, subject, installationId));
    } catch (error) {
      lastError = error;
      if (!isMissingGrantError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

export async function probeStatus(def: ConnectorDef, userId: string): Promise<ConnectorStatus> {
  try {
    const response = await withUserTokenResponse(def, userId);

    return {
      state: "connected",
      installationId: response.installationId,
      label: response.name,
    };
  } catch (error) {
    return mapConnectError(error, def);
  }
}

export async function mintUserToken(
  def: ConnectorDef,
  userId: string,
  installationId?: string,
): Promise<string> {
  const response = await withUserTokenResponse(def, userId, installationId);
  return response.token;
}

export async function startConnectFlow(def: ConnectorDef, userId: string, callbackUrl: string) {
  return startAuthorization(def.connector, tokenParams(def, userSubjects(userId)[0]!, undefined), {
    callbackUrl,
  });
}

export function isValidEveResumeUrl(url: string, origin: string) {
  try {
    const parsed = new URL(url);
    const expected = new URL(origin);

    if (parsed.origin !== expected.origin) {
      return false;
    }

    return /^\/eve\/v1\/connections\/[^/]+\/callback\/[^/]+$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export async function revokeConnection(
  def: ConnectorDef,
  userId: string,
  installationId?: string,
): Promise<void> {
  let lastError: unknown;

  for (const subject of userSubjects(userId)) {
    try {
      const params: { subject: ConnectTokenSubject; installationId?: string } = { subject };
      if (installationId) params.installationId = installationId;
      await revokeToken(def.connector, params);
      return;
    } catch (error) {
      lastError = error;
      if (!isMissingGrantError(error)) {
        throw error;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
}
