import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { HarnessBundle, HarnessPrepareContext } from "../../core/harness.ts";
import { packageName, type CliOptions, type SupportedCliName } from "./plan.ts";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const NODE_VERSION = "24.19.0";
const ARCHES = ["x64", "arm64"] as const;
const SOURCES = ["plan.ts", "runner.ts", "output.ts", "prepare.ts", "index.ts"];

/** Installation is host-only, serial, and credential-free. Both Linux/glibc
 * architectures are prepared because the Harness contract selects arch only after upload.
 * Lifecycle scripts are disabled; native CLI launchers use their optional platform packages.
 */
export async function prepareCliBundle(
  name: SupportedCliName,
  options: CliOptions,
  ctx: HarnessPrepareContext,
): Promise<HarnessBundle> {
  const cache = resolve(ctx.cacheDir, "cli");
  await mkdir(cache, { recursive: true });
  const scratch = await mkdtemp(join(cache, ".prepare-"));
  const cleanEnv = { PATH: process.env.PATH, HOME: join(scratch, "home"), CI: "true" };
  await mkdir(cleanEnv.HOME, { recursive: true });
  try {
    let pnpmVersion: string;
    try {
      pnpmVersion = (
        await exec("pnpm", ["--version"], { env: cleanEnv, cwd: scratch })
      ).stdout.trim();
    } catch {
      throw new Error(
        "CLI bundles require pnpm 11+ on the host; pnpm could not run. No container installation was attempted.",
      );
    }
    if (!/^(?:1[1-9]|[2-9]\d)\./.test(pnpmVersion)) {
      throw new Error(
        "CLI bundles require pnpm 11+ for explicit Linux CPU/libc installs. No container installation was attempted.",
      );
    }
    const sources = await Promise.all(SOURCES.map((file) => readFile(join(here, file))));
    const sourceSha256 = sha256(Buffer.concat(sources));
    const pkg = packageName(name, options.version);
    const key = sha256(
      JSON.stringify({ pkg, version: options.version, pnpmVersion, NODE_VERSION, sourceSha256 }),
    );
    const dir = join(cache, key);
    if (await exists(join(dir, "provenance.json"))) return await bundleAt(dir);

    const started = Date.now();
    const building = join(scratch, "bundle");
    const common = join(building, "common");
    await mkdir(common, { recursive: true });
    for (const source of ["runner.ts", "plan.ts", "output.ts"])
      await cp(join(here, source), join(common, source));
    const lockSha256: Record<string, string> = {};
    const nodeSha256: Record<string, string> = {};
    for (const arch of ARCHES) {
      const archDir = join(building, arch);
      const app = join(archDir, "app");
      await mkdir(app, { recursive: true });
      await writeFile(
        join(app, "package.json"),
        JSON.stringify({
          name: "eve-bench-cli-bundle",
          private: true,
          type: "module",
          dependencies: { [pkg]: options.version },
        }),
      );
      await writeFile(join(app, ".npmrc"), "registry=https://registry.npmjs.org/\n");
      try {
        await exec(
          "pnpm",
          [
            "install",
            "--ignore-workspace",
            "--ignore-scripts",
            "--ignore-pnpmfile",
            "--no-frozen-lockfile",
            "--prod",
            "--os=linux",
            `--cpu=${arch}`,
            "--libc=glibc",
            "--package-import-method=copy",
            "--network-concurrency=2",
            "--child-concurrency=1",
            "--store-dir",
            join(cache, "store"),
            "--reporter=silent",
          ],
          { cwd: app, env: cleanEnv, maxBuffer: 1024 * 1024 },
        );
      } catch {
        // Do not embed package-manager stdout/errors: registry diagnostics may contain credentials.
        throw new Error(
          `Host pnpm install failed for ${pkg}@${options.version} (linux/${arch}, scripts disabled). No CLI setup was moved into the task timeout.`,
        );
      }
      const manifest = JSON.parse(
        await readFile(join(app, "node_modules", pkg, "package.json"), "utf8"),
      ) as {
        version: string;
        bin?: string | Record<string, string>;
      };
      if (manifest.version !== options.version)
        throw new Error("Installed CLI version does not match the explicit pin");
      const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
      if (!bin || isAbsolute(bin))
        throw new Error("Pinned CLI package has no supported relative executable entry");
      const packageRoot = join(app, "node_modules", pkg);
      let entry = resolve(packageRoot, bin);
      let native = false;
      if (name === "opencode") {
        const platform = arch === "x64" ? "opencode-linux-x64-baseline" : "opencode-linux-arm64";
        entry = join(
          app,
          "node_modules/.pnpm",
          `${platform}@${options.version}`,
          "node_modules",
          platform,
          "bin/opencode",
        );
        native = true;
      }
      if (!(await exists(entry))) {
        throw new Error(
          "Pinned CLI package executable is missing for the requested Linux platform",
        );
      }
      if (!native && relative(packageRoot, entry).startsWith("..")) {
        throw new Error("Pinned CLI package executable escapes its package");
      }
      await writeFile(
        join(archDir, "entry.json"),
        JSON.stringify({ entry: relative(archDir, entry), native }),
      );
      lockSha256[arch] = sha256(await readFile(join(app, "pnpm-lock.yaml")));
      nodeSha256[arch] = await installNode(archDir, arch, scratch);
    }
    const provenance = {
      key,
      name,
      version: options.version,
      package: pkg,
      sourceSha256,
      installLocation: "host",
      containerInstallMs: 0,
      hostPrepareMs: Date.now() - started,
      pnpmVersion,
      nodeVersion: NODE_VERSION,
      platforms: ["linux-x64-glibc", "linux-arm64-glibc"],
      lifecycleScripts: false,
      lockSha256,
      nodeSha256,
      adapterSources: {
        harbor:
          "https://github.com/harbor-framework/harbor/tree/2fe1615503fed39ad82b7ce09b22497996b30f1f/src/harbor/agents/installed",
        codexEnvAuth:
          "https://github.com/openai/codex/blob/1aaa453ce2868e14c10089c226ebec265657cb27/codex-rs/model-provider-info/src/lib.rs",
        opencodeProviders:
          "https://github.com/anomalyco/opencode/blob/ac1758c0e6b8e7368be133e87e8e27a5f60dec04/packages/opencode/src/provider/provider.ts",
      },
      limitations: [
        "Native CLI/platform compatibility is not inferred from mock tests.",
        "Host pnpm 11+ and Linux glibc containers are required; no musl/system-package bootstrap.",
        "CLI-owned startup work is included in invocation wall time, not independently measured.",
        "Custom model context/output limits use CLI defaults; reasoning settings are not normalized between agents.",
        "Codex requires a Responses-compatible endpoint/model; no chat-completions fallback.",
        "Native state stays ephemeral; only redacted stdout/stderr is exported. Usage is not normalized.",
      ],
    };
    await writeFile(join(building, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    await cp(join(building, "provenance.json"), join(common, "provenance.json"));
    try {
      await rename(building, dir);
    } catch (error) {
      if (!(await exists(join(dir, "provenance.json")))) throw error;
    }
    return await bundleAt(dir);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function bundleAt(dir: string): Promise<HarnessBundle> {
  // Keep platform trees out of the common upload (which otherwise doubles every transfer).
  return {
    dir: join(dir, "common"),
    arch: { x64: join(dir, "x64"), arm64: join(dir, "arm64") },
    provenance: JSON.parse(await readFile(join(dir, "provenance.json"), "utf8")) as Record<
      string,
      unknown
    >,
  };
}

async function installNode(archDir: string, arch: string, scratch: string): Promise<string> {
  const name = `node-v${NODE_VERSION}-linux-${arch}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = (await download(`${base}/SHASUMS256.txt`, 1024 * 1024)).toString("utf8");
  const expected = sums
    .split("\n")
    .find((line) => line.trim().endsWith(` ${name}.tar.xz`))
    ?.split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error("Pinned Node checksum is missing");
  const archive = await download(`${base}/${name}.tar.xz`, 128 * 1024 * 1024);
  if (sha256(archive) !== expected) throw new Error("Pinned Node archive checksum mismatch");
  const path = join(scratch, `${name}.tar.xz`);
  await writeFile(path, archive);
  await exec("tar", ["-xJf", path, "--strip-components=2", "-C", archDir, `${name}/bin/node`]);
  await chmod(join(archDir, "node"), 0o755);
  await rm(path);
  return expected;
}

async function download(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "error" });
  if (!response.ok || !response.body)
    throw new Error(`Pinned Node download failed (HTTP ${response.status})`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("Pinned Node download exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
