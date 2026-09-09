const port = process.env.EVE_COMPUTE_POSTGRES_PORT ?? "55432";
const host = process.env.EVE_COMPUTE_POSTGRES_HOST ?? "127.0.0.1";
const database = process.env.EVE_COMPUTE_POSTGRES_DATABASE ?? "eve_compute";
const namespaceId = process.env.EVE_COMPUTE_NAMESPACE ?? "00000000-0000-4000-8000-000000000001";

function localUrl(user: string, password: string): string {
  const url = new URL(`postgres://${host}:${port}/${database}`);
  url.username = user;
  url.password = password;
  return url.toString();
}

export const computePlatformConfig = {
  adminUrl: process.env.EVE_COMPUTE_ADMIN_URL ?? localUrl("eve_compute_admin", "eve_compute_admin"),
  endpoint:
    process.env.EVE_COMPUTE_ENDPOINT ??
    `http://127.0.0.1:${process.env.EVE_COMPUTE_GATEWAY_PORT ?? "55431"}`,
  inspectorUrl:
    process.env.EVE_COMPUTE_INSPECTOR_URL ??
    localUrl("eve_compute_inspector", "eve_compute_inspector"),
  migratorUrl:
    process.env.EVE_COMPUTE_MIGRATOR_URL ??
    localUrl("eve_compute_migrator", "eve_compute_migrator"),
  namespaceId,
  runtimeUrl:
    process.env.EVE_COMPUTE_RUNTIME_URL ?? localUrl("eve_compute_runtime", "eve_compute_runtime"),
};

export function requireComputeToken(): string {
  const token = process.env.EVE_COMPUTE_TOKEN;
  if (token === undefined || Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("EVE_COMPUTE_TOKEN must contain at least 32 UTF-8 bytes.");
  }
  return token;
}
import { Buffer } from "node:buffer";
