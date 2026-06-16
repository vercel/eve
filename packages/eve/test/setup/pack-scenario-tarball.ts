import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const EVE_PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EVE_PACKAGE_NAME_TARBALL_PREFIX = "eve";
const SCENARIO_CACHE_ROOT = join(tmpdir(), "eve-scenario-cache");
const SHARED_TARBALLS_ROOT = join(SCENARIO_CACHE_ROOT, "shared-tarballs");

/**
 * Vitest `globalSetup` that packs the eve package exactly once before any
 * scenario worker boots. The resulting tarball path is exposed to workers
 * through `process.env.EVE_SCENARIO_EVE_TARBALL_PATH` so
 * `materializeScenarioApp()` can reuse it instead of racing to run
 * `pnpm pack` concurrently (which triggers `prepack` → `pnpm run clean &&
 * build`, a shared-state operation that corrupts `dist/` when run in
 * parallel).
 *
 * Running once upfront avoids that race and also saves N × ~4s of cold-pack
 * time when file parallelism is enabled.
 */
export default async function packScenarioTarball(): Promise<void> {
  await rm(SHARED_TARBALLS_ROOT, {
    force: true,
    recursive: true,
  });
  await mkdir(SHARED_TARBALLS_ROOT, {
    recursive: true,
  });

  await runPnpmCommand({
    args: ["pack", "--pack-destination", SHARED_TARBALLS_ROOT, "--config.minimum-release-age=0"],
    cwd: EVE_PACKAGE_ROOT,
  });

  const tarballName = await resolveTarballName();
  const tarballPath = join(SHARED_TARBALLS_ROOT, tarballName);

  process.env.EVE_SCENARIO_EVE_TARBALL_PATH = tarballPath;
}

async function resolveTarballName(): Promise<string> {
  const entries = await readdir(SHARED_TARBALLS_ROOT);
  const tarballName = entries
    .filter(
      (entry) => entry.startsWith(`${EVE_PACKAGE_NAME_TARBALL_PREFIX}-`) && entry.endsWith(".tgz"),
    )
    .sort((left, right) => left.localeCompare(right))
    .at(-1);

  if (tarballName === undefined) {
    throw new Error(
      `Expected pnpm pack to emit a ${EVE_PACKAGE_NAME_TARBALL_PREFIX}-*.tgz tarball in "${SHARED_TARBALLS_ROOT}".`,
    );
  }

  return tarballName;
}
