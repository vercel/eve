import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDevelopmentEnvironmentFiles } from "../../src/cli/dev/environment.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

const DEVELOPMENT_ENV_KEYS = [
  "EVE_DEV_DEFAULT_ONLY",
  "EVE_DEV_DEVELOPMENT_LOCAL_ONLY",
  "EVE_DEV_DEVELOPMENT_ONLY",
  "EVE_DEV_LOCAL_ONLY",
  "EVE_DEV_SHARED",
  "EVE_DEV_SHELL_ONLY",
] as const;

async function createEnvironmentFixture(): Promise<string> {
  const fixtureRoot = await createScratchDirectory("eve-dev-env-");

  await writeFile(
    join(fixtureRoot, ".env"),
    [
      "EVE_DEV_DEFAULT_ONLY=from-env",
      "EVE_DEV_SHARED=from-env",
      "EVE_DEV_SHELL_ONLY=from-env",
    ].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, ".env.development"),
    ["EVE_DEV_DEVELOPMENT_ONLY=from-development"].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, ".env.local"),
    ["EVE_DEV_LOCAL_ONLY=from-local", "EVE_DEV_SHARED=from-local"].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, ".env.development.local"),
    ["EVE_DEV_DEVELOPMENT_LOCAL_ONLY=from-development-local"].join("\n"),
  );

  return fixtureRoot;
}

function clearDevelopmentEnvironment(): void {
  for (const key of DEVELOPMENT_ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearDevelopmentEnvironment();
});

describe("loadDevelopmentEnvironmentFiles", () => {
  it("loads local development env files in precedence order without overwriting shell vars", async () => {
    const fixtureRoot = await createEnvironmentFixture();

    process.env.EVE_DEV_SHELL_ONLY = "from-shell";

    loadDevelopmentEnvironmentFiles(fixtureRoot);

    expect(process.env.EVE_DEV_DEVELOPMENT_LOCAL_ONLY).toBe("from-development-local");
    expect(process.env.EVE_DEV_LOCAL_ONLY).toBe("from-local");
    expect(process.env.EVE_DEV_DEVELOPMENT_ONLY).toBe("from-development");
    expect(process.env.EVE_DEV_DEFAULT_ONLY).toBe("from-env");
    expect(process.env.EVE_DEV_SHARED).toBe("from-local");
    expect(process.env.EVE_DEV_SHELL_ONLY).toBe("from-shell");
  });
});
