import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadDevelopmentEnvironmentFiles,
  readDevelopmentEnvironmentHostValues,
  stageDevelopmentEnvironmentFiles,
} from "#cli/dev/environment.js";

const ENV_KEYS = [
  "EVE_WATCH_ENV_FILE_ONLY",
  "EVE_WATCH_ENV_NEW",
  "EVE_WATCH_ENV_SHARED",
  "EVE_WATCH_ENV_SHELL",
  "AI_GATEWAY_API_KEY",
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { force: true, recursive: true })),
  );
});

describe("development environment reload transactions", () => {
  it("preserves parent process precedence when env files reload", async () => {
    const appRoot = await createEnvironmentApp();
    process.env.EVE_WATCH_ENV_SHELL = "from-parent";

    loadDevelopmentEnvironmentFiles(appRoot);

    expect(process.env.EVE_WATCH_ENV_FILE_ONLY).toBe("from-env");
    expect(process.env.EVE_WATCH_ENV_SHARED).toBe("from-local");
    expect(process.env.EVE_WATCH_ENV_SHELL).toBe("from-parent");
  });

  it("honors the persisted Gateway credential selection over available keys", async () => {
    const appRoot = await createEnvironmentApp();
    await writeFile(join(appRoot, ".env.local"), "AI_GATEWAY_API_KEY=from-file\n");
    await mkdir(join(appRoot, ".eve"));
    await writeFile(join(appRoot, ".eve", "gateway-credential.json"), '{"preferred":"project"}\n');

    loadDevelopmentEnvironmentFiles(appRoot);
    expect(process.env.AI_GATEWAY_API_KEY).toBeUndefined();

    await writeFile(join(appRoot, ".eve", "gateway-credential.json"), '{"preferred":"api-key"}\n');
    loadDevelopmentEnvironmentFiles(appRoot);
    expect(process.env.AI_GATEWAY_API_KEY).toBe("from-file");
  });

  it("fingerprints suppression of a shell Gateway key for Project OIDC", async () => {
    const appRoot = await createEnvironmentApp();
    process.env.AI_GATEWAY_API_KEY = "from-parent";

    loadDevelopmentEnvironmentFiles(appRoot);
    expect(readDevelopmentEnvironmentHostValues(appRoot).AI_GATEWAY_API_KEY).toBe("from-parent");

    await mkdir(join(appRoot, ".eve"));
    await writeFile(join(appRoot, ".eve", "gateway-credential.json"), '{"preferred":"project"}\n');
    loadDevelopmentEnvironmentFiles(appRoot);

    expect(process.env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(readDevelopmentEnvironmentHostValues(appRoot).AI_GATEWAY_API_KEY).toBeNull();
  });

  it("restores the complete prior environment when a candidate is rejected", async () => {
    const appRoot = await createEnvironmentApp();
    const envLocalPath = join(appRoot, ".env.local");
    loadDevelopmentEnvironmentFiles(appRoot);
    await writeFile(
      envLocalPath,
      "EVE_WATCH_ENV_NEW=from-candidate\nEVE_WATCH_ENV_SHARED=from-candidate\n",
    );

    const reload = stageDevelopmentEnvironmentFiles(appRoot);
    expect(process.env.EVE_WATCH_ENV_FILE_ONLY).toBe("from-env");
    expect(process.env.EVE_WATCH_ENV_NEW).toBe("from-candidate");
    expect(process.env.EVE_WATCH_ENV_SHARED).toBe("from-candidate");

    reload.rollback();

    expect(process.env.EVE_WATCH_ENV_FILE_ONLY).toBe("from-env");
    expect(process.env.EVE_WATCH_ENV_NEW).toBeUndefined();
    expect(process.env.EVE_WATCH_ENV_SHARED).toBe("from-local");
  });

  it("retains the candidate environment after commit", async () => {
    const appRoot = await createEnvironmentApp();
    loadDevelopmentEnvironmentFiles(appRoot);
    await writeFile(join(appRoot, ".env.local"), "EVE_WATCH_ENV_SHARED=committed\n");

    const reload = stageDevelopmentEnvironmentFiles(appRoot);
    reload.commit();
    reload.rollback();

    expect(process.env.EVE_WATCH_ENV_SHARED).toBe("committed");
  });

  it("reapplies a rolled-back environment edit when a later rebuild stages again", async () => {
    const appRoot = await createEnvironmentApp();
    loadDevelopmentEnvironmentFiles(appRoot);
    await writeFile(join(appRoot, ".env.local"), "EVE_WATCH_ENV_SHARED=after-fix\n");

    stageDevelopmentEnvironmentFiles(appRoot).rollback();
    expect(process.env.EVE_WATCH_ENV_SHARED).toBe("from-local");

    // The retry rebuild carries no env-file change of its own; staging from
    // the files on disk must still pick the edit up.
    const retry = stageDevelopmentEnvironmentFiles(appRoot);
    retry.commit();

    expect(process.env.EVE_WATCH_ENV_SHARED).toBe("after-fix");
  });
});

async function createEnvironmentApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-dev-env-transaction-"));
  temporaryDirectories.push(appRoot);
  await writeFile(
    join(appRoot, ".env"),
    "EVE_WATCH_ENV_FILE_ONLY=from-env\nEVE_WATCH_ENV_SHARED=from-env\nEVE_WATCH_ENV_SHELL=from-env\n",
  );
  await writeFile(join(appRoot, ".env.local"), "EVE_WATCH_ENV_SHARED=from-local\n");
  return appRoot;
}
