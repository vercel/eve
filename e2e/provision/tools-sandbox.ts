import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { Sandbox } from "@vercel/sandbox";

import { provision } from "./lib.ts";
import { theme } from "../lib/theme.ts";

const APP_NAME = "agent-tools-sandbox";
const PORT = Number(process.env.PORT ?? 3350);

const AUTHOR_MARKER_PATH = "/home/vercel-sandbox/eve-author-snapshot-marker.txt";

await provision("tools-sandbox", async (ctx) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EVE_MOCK_AUTHORED_MODELS: "1",
  };

  /*
   * Author-snapshot seeding needs real Vercel Sandbox credentials, so it is
   * opt-in for local runs. Without it the eval's author-snapshot case skips
   * on its missing `env:EVE_TEST_AUTHOR_SNAPSHOT_ID` requirement.
   */
  if (process.env.EVE_E2E_AUTHOR_SNAPSHOT === "1") {
    const seeded = await seedAuthorSnapshot();
    env.EVE_TEST_AUTHOR_SNAPSHOT_ID = seeded.snapshotId;
    env.EVE_TEST_AUTHOR_MARKER_TOKEN = seeded.markerToken;
  }

  const server = await ctx.server({ appName: APP_NAME, env, port: PORT });
  await ctx.runEval({ appName: APP_NAME, env, url: server.baseUrl });
});

/**
 * Builds an author snapshot outside eve: create a standalone Vercel Sandbox,
 * write a fresh marker token outside `/workspace`, snapshot it, and delete
 * the seed. The fixture's sandbox definition rebinds its backend to
 * `vercel({ source: { type: "snapshot", snapshotId } })` when
 * `EVE_TEST_AUTHOR_SNAPSHOT_ID` is set.
 */
async function seedAuthorSnapshot(): Promise<{ snapshotId: string; markerToken: string }> {
  /*
   * The Vercel Sandbox SDK reads credentials from env vars
   * (`VERCEL_OIDC_TOKEN` / `VERCEL_TOKEN`). The agent server picks them up
   * from the fixture's `.env.local` automatically, but this provision
   * process needs them loaded upfront so the standalone `Sandbox.create`
   * below can authenticate.
   */
  const fixtureEnvPath = fileURLToPath(
    new URL(`../fixtures/${APP_NAME}/.env.local`, import.meta.url),
  );
  try {
    process.loadEnvFile(fixtureEnvPath);
  } catch (error) {
    console.warn(
      theme.warning(
        `[tools-sandbox] could not load ${fixtureEnvPath}: ${(error as Error).message}. ` +
          `Set VERCEL_OIDC_TOKEN or VERCEL_TOKEN in your environment to seed the author snapshot.`,
      ),
    );
  }

  /*
   * Each run generates a fresh author snapshotId, but the fixture's template
   * key stays stable (derived from agent code). A previous run that crashed
   * before the framework's `sandbox.snapshot()` call leaves a template
   * sandbox whose `currentSnapshotId` is the orphaned author snapshot from
   * that run, which the runtime would (correctly) reuse as a framework
   * snapshot. Delete leftover templates to keep runs idempotent.
   */
  console.log(theme.muted(`[tools-sandbox] cleaning leftover ${APP_NAME} templates...`));
  const existing = await Sandbox.list({ limit: 50 });
  for (const sb of existing.sandboxes) {
    if (sb.name.startsWith("eve-sbx-tpl-vercel-")) {
      try {
        const handle = await Sandbox.get({ name: sb.name });
        if (handle) await handle.delete();
      } catch {
        // ignore, already gone or no perms
      }
    }
  }

  const markerToken = `author-snapshot-ok-${randomBytes(6).toString("hex")}`;
  const seedSandboxName = `eve-smoke-author-seed-${randomBytes(4).toString("hex")}`;

  console.log(theme.muted(`[tools-sandbox] creating seed sandbox "${seedSandboxName}"...`));
  const seedSandbox = await Sandbox.create({ name: seedSandboxName, persistent: false });

  try {
    const writeResult = await seedSandbox.runCommand({
      args: ["-lc", `printf %s ${markerToken} > ${AUTHOR_MARKER_PATH}`],
      cmd: "bash",
    });
    if (writeResult.exitCode !== 0) {
      const stderr = await writeResult.stderr();
      throw new Error(`Failed to write author marker into seed sandbox: ${stderr}`);
    }

    console.log(theme.muted(`[tools-sandbox] snapshotting seed sandbox...`));
    const snapshot = await seedSandbox.snapshot();
    console.log(theme.muted(`[tools-sandbox] author snapshotId: ${snapshot.snapshotId}`));
    return { markerToken, snapshotId: snapshot.snapshotId };
  } finally {
    try {
      await seedSandbox.delete();
    } catch (error) {
      console.warn(
        theme.warning(`[tools-sandbox] failed to delete seed sandbox (ignoring):`),
        error,
      );
    }
  }
}
