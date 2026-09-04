import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import type { EveEvalContext } from "eve/evals";

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { maxBuffer: 64 * 1024 * 1024 } as const;

/** Rebuilds a fixture against exact eve packages while keeping one public alias. */
export async function createRedeployFixture(t: EveEvalContext) {
  const alias = process.env.EVE_E2E_REDEPLOY_ALIAS;
  if (alias === undefined || alias.length === 0) {
    t.skip("Requires the CI-owned EVE_E2E_REDEPLOY_ALIAS; run via the Vercel redeploy suite.");
  }
  if (new URL(t.target.url).host !== alias) {
    throw new Error("The redeploy alias must match the eval target host.");
  }

  const instructionsPath = resolve("agent", "instructions.md");
  const instructions = await readFile(instructionsPath, "utf8");
  const links = await Promise.all(
    [resolve("node_modules", "eve"), resolve("..", "e2e-config", "node_modules", "eve")].map(
      async (path) => ({ path, target: await readlink(path) }),
    ),
  );
  const currentPackage = await realpath(links[0]!.path);
  const execOptions = { ...EXEC_OPTIONS, signal: t.signal };
  const stagedPackages: string[] = [];

  return {
    currentPackage,
    async stagePublishedEve(packagePath: string): Promise<string> {
      const cache = resolve("node_modules", ".cache");
      await mkdir(cache, { recursive: true });
      const staged = await mkdtemp(resolve(cache, "eve-published-"));
      stagedPackages.push(staged);
      await cp(packagePath, staged, {
        recursive: true,
        filter: (source) => source !== resolve(packagePath, "node_modules"),
      });
      await symlink(dirname(packagePath), resolve(staged, "node_modules"));
      const manifestPath = resolve(staged, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      // Historical source-only export conditions point to files absent from npm.
      // Change package resolution in this copy; preserve every published code byte.
      await writeFile(
        manifestPath,
        `${JSON.stringify(withoutSourceConditions(manifest), null, 2)}\n`,
      );
      return staged;
    },
    async deploy(packagePath: string, marker: string): Promise<string> {
      for (const link of links) await replaceLink(link.path, packagePath);
      await writeFile(instructionsPath, `${instructions}\nDeployment marker: ${marker}.\n`);
      await execFileAsync("pnpm", ["exec", "eve", "build"], {
        ...execOptions,
        env: {
          ...process.env,
          VERCEL: "1",
          VERCEL_ENV: "preview",
          VERCEL_TARGET_ENV: "preview",
        },
      });
      const tokenArgs =
        process.env.VERCEL_TOKEN === undefined ? [] : ["--token", process.env.VERCEL_TOKEN];
      const scopeArgs =
        process.env.VERCEL_ORG_ID === undefined ? [] : ["--scope", process.env.VERCEL_ORG_ID];
      const modelArgs =
        process.env.EVE_E2E_MODEL === undefined
          ? []
          : ["--env", `EVE_E2E_MODEL=${process.env.EVE_E2E_MODEL}`];
      const deploy = await execFileAsync(
        "pnpm",
        [
          "exec",
          "vc",
          "deploy",
          "--prebuilt",
          "--yes",
          "--target=preview",
          ...modelArgs,
          ...tokenArgs,
        ],
        execOptions,
      );
      const deploymentUrl = deploy.stdout.trim().split("\n").at(-1)?.trim();
      if (deploymentUrl === undefined || !deploymentUrl.startsWith("https://")) {
        throw new Error("vc deploy did not return a deployment URL.");
      }
      t.log(`deployed ${deploymentUrl} (${marker}); aliasing ${alias}`);
      await execFileAsync(
        "pnpm",
        ["exec", "vc", "alias", "set", deploymentUrl, alias, ...tokenArgs, ...scopeArgs],
        execOptions,
      );
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        try {
          const response = await t.target.fetch("/eve/v1/info", { cache: "no-store" });
          if (response.ok && JSON.stringify(await response.json()).includes(marker))
            return deploymentUrl;
        } catch {
          // The alias can be unavailable briefly while the deployment propagates.
        }
        await t.sleep(1_000);
      }
      throw new Error(`Timed out waiting for alias to serve ${marker}.`);
    },
    async restore(): Promise<void> {
      for (const link of links) await replaceLink(link.path, link.target);
      await writeFile(instructionsPath, instructions);
      for (const staged of stagedPackages) await rm(staged, { force: true, recursive: true });
    },
  };
}

function withoutSourceConditions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSourceConditions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "eve-source")
      .map(([key, entry]) => [key, withoutSourceConditions(entry)]),
  );
}

async function replaceLink(path: string, target: string): Promise<void> {
  await rm(path, { force: true });
  await symlink(target, path);
}

export async function readEveVersion(packagePath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(packagePath, "package.json"), "utf8")) as {
    version?: string;
  };
  if (manifest.version === undefined) throw new Error("eve package is missing its version.");
  return manifest.version;
}
