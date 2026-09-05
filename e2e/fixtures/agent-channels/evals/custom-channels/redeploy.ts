import { execFile } from "node:child_process";
import { readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { EveEvalContext } from "eve/evals";

const ALIAS_ENV = "EVE_E2E_REDEPLOY_ALIAS";
const INSTRUCTIONS_PATH = resolve("agent", "instructions.md");
const FIXTURE_EVE_LINK = resolve("node_modules", "eve");
const CONFIG_EVE_LINK = resolve("..", "e2e-config", "node_modules", "eve");
const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { maxBuffer: 64 * 1024 * 1024 } as const;

/** Deploy a published version, then let the test upgrade the same alias to current code. */
export async function withOldDeployment(
  t: EveEvalContext,
  version: string,
  test: (upgrade: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const alias =
    process.env[ALIAS_ENV] ||
    t.skip(`Requires ${ALIAS_ENV}; run via the e2e-vercel redeploy step.`);
  if (new URL(t.target.url).host !== alias) {
    throw new Error(`${ALIAS_ENV} must match the eval target host.`);
  }

  const instructions = await readFile(INSTRUCTIONS_PATH, "utf8");
  const links = await Promise.all([snapshotLink(FIXTURE_EVE_LINK), snapshotLink(CONFIG_EVE_LINK)]);
  const oldPackage = await realpath(
    resolve("node_modules", `historical-eve-${version.replaceAll(".", "-")}`),
  );
  if ((await readPackageVersion(oldPackage)) !== version) {
    throw new Error(`Historical eve package must resolve exactly ${version}.`);
  }

  async function deploy(marker: string): Promise<void> {
    await writeFile(INSTRUCTIONS_PATH, `${instructions}\nDeployment marker: ${marker}.\n`);
    await deployToAlias(t, alias, marker);
    await waitForAliasToServe(t, marker);
  }

  try {
    await replaceLink(FIXTURE_EVE_LINK, oldPackage);
    await replaceLink(CONFIG_EVE_LINK, oldPackage);
    await deploy(`cross-version-eve-${version}`);
    await test(async () => {
      await restoreLinks(links);
      await deploy("cross-version-eve-current");
    });
  } finally {
    await restoreLinks(links);
    await writeFile(INSTRUCTIONS_PATH, instructions);
  }
}

interface LinkSnapshot {
  readonly path: string;
  readonly target: string;
}

async function snapshotLink(path: string): Promise<LinkSnapshot> {
  return { path, target: await readlink(path) };
}

async function replaceLink(path: string, target: string): Promise<void> {
  await rm(path, { force: true });
  await symlink(target, path);
}

async function restoreLinks(links: readonly LinkSnapshot[]): Promise<void> {
  for (const link of links) {
    await replaceLink(link.path, link.target);
  }
}

async function readPackageVersion(packagePath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(packagePath, "package.json"), "utf8")) as {
    version?: string;
  };
  if (manifest.version === undefined) {
    throw new Error(`Package at ${packagePath} has no version.`);
  }
  return manifest.version;
}

/** Builds the fixture and repoints the run-scoped alias at the fresh deployment. */
async function deployToAlias(t: EveEvalContext, alias: string, phase: string): Promise<void> {
  await execFileAsync("pnpm", ["exec", "eve", "build"], {
    ...EXEC_OPTIONS,
    env: {
      ...process.env,
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_TARGET_ENV: "preview",
    },
  });
  const tokenArgs =
    process.env.VERCEL_TOKEN === undefined ? [] : ["--token", process.env.VERCEL_TOKEN];
  const modelArgs =
    process.env.EVE_E2E_MODEL === undefined
      ? []
      : ["--env", `EVE_E2E_MODEL=${process.env.EVE_E2E_MODEL}`];
  const scopeArgs =
    process.env.VERCEL_ORG_ID === undefined ? [] : ["--scope", process.env.VERCEL_ORG_ID];
  const deploy = await execFileAsync(
    "pnpm",
    ["exec", "vc", "deploy", "--prebuilt", "--yes", "--target=preview", ...modelArgs, ...tokenArgs],
    EXEC_OPTIONS,
  );
  const deploymentUrl = deploy.stdout.trim().split("\n").at(-1)?.trim();
  if (deploymentUrl === undefined || !deploymentUrl.startsWith("https://")) {
    throw new Error(`vc deploy did not print a deployment URL; got: ${deploy.stdout}`);
  }
  t.log(`deployed ${deploymentUrl} (${phase}); aliasing ${alias}`);

  await execFileAsync(
    "pnpm",
    ["exec", "vc", "alias", "set", deploymentUrl, alias, ...tokenArgs, ...scopeArgs],
    EXEC_OPTIONS,
  );
}

/** Waits until the alias exposes the marker from the expected deployment. */
async function waitForAliasToServe(t: EveEvalContext, marker: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastStatus = "transport error";
  let lastMarkerMatch = false;
  let consecutiveMatches = 0;
  while (Date.now() < deadline) {
    try {
      const response = await t.target.fetch("/eve/v1/info", { cache: "no-store" });
      lastStatus = String(response.status);
      lastMarkerMatch = response.ok && JSON.stringify(await response.json()).includes(marker);
      consecutiveMatches = lastMarkerMatch ? consecutiveMatches + 1 : 0;
      if (consecutiveMatches === 5) return;
    } catch {
      consecutiveMatches = 0;
      // The alias may briefly be unavailable while its deployment propagates.
    }
    await t.sleep(1_000);
  }
  throw new Error(
    `Timed out waiting for alias ${new URL(t.target.url).host} to serve marker ${marker}; ` +
      `last status=${lastStatus}, marker matched=${lastMarkerMatch}.`,
  );
}
