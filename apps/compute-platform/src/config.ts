const port = process.env.EVE_COMPUTE_POSTGRES_PORT ?? "55432";
const host = process.env.EVE_COMPUTE_POSTGRES_HOST ?? "127.0.0.1";
const database = process.env.EVE_COMPUTE_POSTGRES_DATABASE ?? "eve_compute";

function localUrl(user: string, password: string): string {
  const url = new URL(`postgres://${host}:${port}/${database}`);
  url.username = user;
  url.password = password;
  return url.toString();
}

export const computePlatformConfig = {
  adminUrl: process.env.EVE_COMPUTE_ADMIN_URL ?? localUrl("eve_compute_admin", "eve_compute_admin"),
  inspectorUrl:
    process.env.EVE_COMPUTE_INSPECTOR_URL ??
    localUrl("eve_compute_inspector", "eve_compute_inspector"),
  migratorUrl:
    process.env.EVE_COMPUTE_MIGRATOR_URL ??
    localUrl("eve_compute_migrator", "eve_compute_migrator"),
  runtimeUrl:
    process.env.EVE_COMPUTE_RUNTIME_URL ?? localUrl("eve_compute_runtime", "eve_compute_runtime"),
};
