import { setTimeout as sleep } from "node:timers/promises";

const PHOTON_DASHBOARD_HOST = "https://app.photon.codes";
const PHOTON_SPECTRUM_HOST = "https://spectrum.photon.codes";
const PHOTON_DEVICE_CLIENT_ID = "photon-cli";
const E164 = /^\+[1-9]\d{6,14}$/;

/** Validates international syntax and the fixed-length North American numbering plan. */
export function validatePhotonPhoneNumber(value: string): string | null {
  const phoneNumber = value.trim();
  if (!E164.test(phoneNumber)) {
    return "Use E.164 format: + followed by 7–15 digits, for example +15551234567";
  }
  if (phoneNumber.startsWith("+1") && phoneNumber.length !== 12) {
    return "US and Canadian numbers must be +1 followed by exactly 10 digits";
  }
  return null;
}

interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export interface PhotonManagedProject {
  projectId: string;
  projectSecret: string;
  assignedPhoneNumber?: string;
  /** Deletes the dedicated project when a later setup phase fails. */
  cleanup(): Promise<void>;
}

export interface PhotonDeviceAuthorization {
  userCode: string;
  verificationUrl: string;
}

export interface ProvisionPhotonProjectOptions {
  projectName: string;
  phoneNumber: string;
  onAuthorization(authorization: PhotonDeviceAuthorization): void;
  signal?: AbortSignal;
  deps?: PhotonManagementDeps;
}

export interface UsePhotonProjectOptions {
  projectId: string;
  projectSecret: string;
  phoneNumber: string;
  deps?: PhotonManagementDeps;
}

export interface PhotonManagementDeps {
  fetch: typeof fetch;
  delay(ms: number, signal?: AbortSignal): Promise<void>;
}

const defaultDeps: PhotonManagementDeps = {
  fetch,
  delay: (ms, signal) => sleep(ms, undefined, { signal }),
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Photon returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

async function json(response: Response, action: string): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const value = record(body);
    const detail = value["error"] ?? value["message"] ?? response.statusText;
    throw new Error(`Photon ${action} failed: ${String(detail)}`);
  }
  return record(body);
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function basic(projectId: string, projectSecret: string): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`${projectId}:${projectSecret}`).toString("base64")}`,
    "content-type": "application/json",
  };
}

async function requestDeviceCode(deps: PhotonManagementDeps): Promise<DeviceCodeResponse> {
  const response = await deps.fetch(`${PHOTON_DASHBOARD_HOST}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: PHOTON_DEVICE_CLIENT_ID, scope: "openid profile email" }),
  });
  const body = await json(response, "device login");
  const deviceCode = body["device_code"];
  const userCode = body["user_code"];
  const verificationUrl = body["verification_uri_complete"] ?? body["verification_uri"];
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUrl !== "string"
  ) {
    throw new Error("Photon returned an invalid device authorization response.");
  }
  return {
    deviceCode,
    userCode,
    verificationUrl,
    expiresIn: typeof body["expires_in"] === "number" ? body["expires_in"] : 1800,
    interval: typeof body["interval"] === "number" ? body["interval"] : 5,
  };
}

async function pollForToken(
  code: DeviceCodeResponse,
  deps: PhotonManagementDeps,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + code.expiresIn * 1000;
  let intervalMs = code.interval * 1000;
  while (Date.now() < deadline) {
    await deps.delay(intervalMs, signal);
    const response = await deps.fetch(`${PHOTON_DASHBOARD_HOST}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.deviceCode,
        client_id: PHOTON_DEVICE_CLIENT_ID,
      }),
      signal,
    });
    const body = record(await response.json().catch(() => ({})));
    if (response.ok) {
      const token = body["access_token"] ?? body["accessToken"];
      if (typeof token === "string" && token.length > 0) return token;
      throw new Error("Photon approved device login without returning an access token.");
    }
    const error = body["error"] ?? body["message"];
    if (error === "authorization_pending") continue;
    if (error === "slow_down" || response.status === 429) {
      intervalMs += response.status === 429 ? 10_000 : 5_000;
      continue;
    }
    throw new Error(`Photon device login failed: ${String(error ?? response.statusText)}`);
  }
  throw new Error("Photon device login timed out.");
}

async function createProject(
  token: string,
  name: string,
  deps: PhotonManagementDeps,
): Promise<string> {
  const response = await deps.fetch(`${PHOTON_DASHBOARD_HOST}/api/projects`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({
      name,
      location: "United States",
      platforms: ["imessage"],
      template: false,
      observability: false,
    }),
  });
  const body = await json(response, "project creation");
  if (typeof body["id"] !== "string") throw new Error("Photon did not return a project ID.");
  return body["id"];
}

async function regenerateSecret(
  token: string,
  projectId: string,
  deps: PhotonManagementDeps,
): Promise<string> {
  const response = await deps.fetch(
    `${PHOTON_DASHBOARD_HOST}/api/projects/${encodeURIComponent(projectId)}/regenerate-secret`,
    { method: "POST", headers: bearer(token), body: "{}" },
  );
  const body = await json(response, "project credential provisioning");
  if (typeof body["projectSecret"] !== "string") {
    throw new Error("Photon did not return the new project secret.");
  }
  return body["projectSecret"];
}

async function registerUser(
  projectId: string,
  projectSecret: string,
  phoneNumber: string,
  deps: PhotonManagementDeps,
): Promise<string | undefined> {
  const response = await deps.fetch(
    `${PHOTON_SPECTRUM_HOST}/projects/${encodeURIComponent(projectId)}/users/`,
    {
      method: "POST",
      headers: basic(projectId, projectSecret),
      body: JSON.stringify({ type: "shared", phoneNumber }),
    },
  );
  const body = await json(response, "phone registration");
  const data = record(body["data"] ?? body);
  const user = record(data["user"] ?? data);
  const assignedPhoneNumber = user["assignedPhoneNumber"] ?? user["phoneNumber"];
  return typeof assignedPhoneNumber === "string" ? assignedPhoneNumber : undefined;
}

async function deleteProject(
  token: string,
  projectId: string,
  deps: PhotonManagementDeps,
): Promise<void> {
  const response = await deps.fetch(
    `${PHOTON_DASHBOARD_HOST}/api/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE", headers: bearer(token) },
  );
  if (!response.ok && response.status !== 404) await json(response, "project cleanup");
}

/** Authorizes Photon and creates an isolated iMessage project for one eve agent. */
export async function provisionPhotonProject(
  options: ProvisionPhotonProjectOptions,
): Promise<PhotonManagedProject> {
  const phoneNumber = options.phoneNumber.trim();
  const validationError = validatePhotonPhoneNumber(phoneNumber);
  if (validationError !== null)
    throw new Error(`Photon phone number is invalid. ${validationError}.`);
  const deps = options.deps ?? defaultDeps;
  const code = await requestDeviceCode(deps);
  options.onAuthorization({ userCode: code.userCode, verificationUrl: code.verificationUrl });
  const token = await pollForToken(code, deps, options.signal);
  const projectId = await createProject(token, options.projectName, deps);
  const cleanup = () => deleteProject(token, projectId, deps);
  try {
    const projectSecret = await regenerateSecret(token, projectId, deps);
    const assignedPhoneNumber = await registerUser(projectId, projectSecret, phoneNumber, deps);
    return assignedPhoneNumber === undefined
      ? { projectId, projectSecret, cleanup }
      : { projectId, projectSecret, assignedPhoneNumber, cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

/** Validates existing Photon credentials and registers the agent's iMessage user. */
export async function usePhotonProject(
  options: UsePhotonProjectOptions,
): Promise<PhotonManagedProject> {
  const phoneNumber = options.phoneNumber.trim();
  const validationError = validatePhotonPhoneNumber(phoneNumber);
  if (validationError !== null)
    throw new Error(`Photon phone number is invalid. ${validationError}.`);
  const projectId = options.projectId.trim();
  const projectSecret = options.projectSecret.trim();
  if (!projectId || !projectSecret) {
    throw new Error("Photon project ID and project secret are required.");
  }
  const assignedPhoneNumber = await registerUser(
    projectId,
    projectSecret,
    phoneNumber,
    options.deps ?? defaultDeps,
  );
  const cleanup = async () => {};
  return assignedPhoneNumber === undefined
    ? { projectId, projectSecret, cleanup }
    : { projectId, projectSecret, assignedPhoneNumber, cleanup };
}
