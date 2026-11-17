import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const EVE_PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EVE_PACKAGE_NAME_TARBALL_PREFIX = "eve";
const SCENARIO_CACHE_ROOT = join(tmpdir(), "eve-scenario-cache");
const PREBUILT_EVE_ENTRY = join(EVE_PACKAGE_ROOT, "dist", "src", "index.js");

export default async function packScenarioTarball(): Promise<() => Promise<void>> {
  try {
    await access(PREBUILT_EVE_ENTRY);
  } catch {
    throw new Error(
      `Scenario tests require a prebuilt eve package. Run "pnpm build" before "pnpm test:scenario". Missing: ${PREBUILT_EVE_ENTRY}`,
    );
  }

  await mkdir(SCENARIO_CACHE_ROOT, {
    recursive: true,
  });
  const tarballsRoot = await mkdtemp(join(SCENARIO_CACHE_ROOT, "shared-tarballs-"));

  await runPnpmCommand({
    args: [
      "pack",
      "--config.ignore-scripts=true",
      "--pack-destination",
      tarballsRoot,
      "--config.minimum-release-age=0",
    ],
    cwd: EVE_PACKAGE_ROOT,
  });

  const tarballName = await resolveTarballName(tarballsRoot);
  const tarballPath = join(tarballsRoot, tarballName);

  process.env.EVE_SCENARIO_EVE_TARBALL_PATH = tarballPath;

  return async () => {
    await rm(tarballsRoot, {
      force: true,
      recursive: true,
    });
  };
}

async function resolveTarballName(tarballsRoot: string): Promise<string> {
  const entries = await readdir(tarballsRoot);
  const tarballName = entries
    .filter(
      (entry) => entry.startsWith(`${EVE_PACKAGE_NAME_TARBALL_PREFIX}-`) && entry.endsWith(".tgz"),
    )
    .sort((left, right) => left.localeCompare(right))
    .at(-1);

  if (tarballName === undefined) {
    throw new Error(
      `Expected pnpm pack to emit a ${EVE_PACKAGE_NAME_TARBALL_PREFIX}-*.tgz tarball in "${tarballsRoot}".`,
    );
  }

  return tarballName;
}
