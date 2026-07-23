import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  persistDevelopmentControlToken,
  readDevelopmentControlToken,
} from "#internal/nitro/dev-control-auth.js";

const CONTROL_TOKEN = "test-development-control-token-that-is-long-enough";
const temporaryRoots: string[] = [];

async function tokenPath(appRoot: string): Promise<string> {
  const digest = createHash("sha256")
    .update(await realpath(appRoot))
    .digest("base64url");
  return join(tmpdir(), "eve-dev-control", `${digest}.token`);
}

async function createAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-dev-control-auth-"));
  temporaryRoots.push(appRoot);
  return appRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      const statePath = await tokenPath(root);
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(statePath, { force: true }),
      ]);
    }),
  );
});

describe("development control token state", () => {
  it("shares the owner-only token with a loopback development client", async () => {
    const appRoot = await createAppRoot();
    await persistDevelopmentControlToken(appRoot, CONTROL_TOKEN);

    await expect(
      readDevelopmentControlToken({ appRoot, serverUrl: "http://127.0.0.1:3000" }),
    ).resolves.toBe(CONTROL_TOKEN);
    await expect(
      readDevelopmentControlToken({
        appRoot: await realpath(appRoot),
        serverUrl: "http://localhost:3000",
      }),
    ).resolves.toBe(CONTROL_TOKEN);
    const tokenFile = await stat(await tokenPath(appRoot));
    expect(tokenFile.mode & 0o777).toBe(0o600);
    const tokenDirectory = await stat(join(tmpdir(), "eve-dev-control"));
    expect(tokenDirectory.mode & 0o777).toBe(0o700);
  });

  it("does not release the token to a non-loopback target", async () => {
    const appRoot = await createAppRoot();
    await persistDevelopmentControlToken(appRoot, CONTROL_TOKEN);

    await expect(
      readDevelopmentControlToken({ appRoot, serverUrl: "http://192.168.1.20:3000" }),
    ).resolves.toBeUndefined();
  });
});
