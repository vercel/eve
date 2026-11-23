import { spawnSync } from "node:child_process";

interface ResolveSandboxImageModule {
  resolveSandboxImage(): void;
}

export default async function resolveBuildSandboxImage(): Promise<void> {
  if (spawnSync("docker", ["buildx", "version"], { stdio: "ignore" }).status !== 0) return;
  const moduleUrl = new URL("../../../../scripts/resolve-sandbox-image.mjs", import.meta.url);
  const { resolveSandboxImage } = (await import(moduleUrl.href)) as ResolveSandboxImageModule;
  resolveSandboxImage();
}
