import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { HarnessBundle, HarnessName, LinuxArch } from "../types.ts";
import { exists, fetchArchBinaries } from "./node-runtime.ts";

const execFileAsync = promisify(execFile);

const PEER_VERSIONS = {
  pi: "1.7.0",
  opencode: "2.2.5",
  fx: "0.0.16",
} as const;

const OPENCODE_SHA256: Readonly<Record<LinuxArch, string>> = {
  x64: "92690eee07a680d3cb760ca02ba43878de9eab1b4e5d5dfae8795518c53628f4",
  arm64: "f8c5a82075fede9b5b044ed6c8a6d13ad807a7e62caea1cd0a878adef49eb053",
};

const FX_RELEASES: Readonly<
  Record<LinuxArch, { readonly target: string; readonly sha256: string }>
> = {
  x64: {
    target: "linux-x86_64",
    sha256: "f0fb822c7be546c80bcc89d50521bc1454435e0c6f586e8420c4e2b84fa80599",
  },
  arm64: {
    target: "linux-aarch64",
    sha256: "ca9441b104357e2105039dbfd4c2eaf0d6ee65a84085f23f51e880c95cbf46af",
  },
};

export async function preparePeerHarness(options: {
  readonly harness: Exclude<HarnessName, "eve-code">;
  readonly cacheDir: string;
}): Promise<HarnessBundle> {
  if (options.harness === "pi") return preparePi(options.cacheDir);
  if (options.harness === "opencode") return prepareOpenCode(options.cacheDir);
  return prepareFx(options.cacheDir);
}

async function preparePi(cacheDir: string): Promise<HarnessBundle> {
  const version = PEER_VERSIONS.pi;
  const bundleDir = join(cacheDir, `pi-${version}`);
  const readyMarker = join(bundleDir, ".ready");

  if (!(await exists(readyMarker))) {
    await mkdir(cacheDir, { recursive: true });
    const stagingDir = join(cacheDir, `pi-${version}.tmp-${randomUUID().slice(0, 8)}`);
    try {
      await mkdir(stagingDir, { recursive: true });
      await writeFile(
        join(stagingDir, "package.json"),
        `${JSON.stringify(
          {
            name: "code-bench-pi",
            private: true,
            type: "module",
            dependencies: { "@earendil-works/pi-coding-agent": version },
          },
          null,
          2,
        )}\n`,
      );
      await execFileAsync(
        "npm",
        ["install", "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts"],
        {
          cwd: stagingDir,
          env: { ...process.env, npm_config_min_release_age: "0" },
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      await writeFile(join(stagingDir, ".ready"), `${version}\n`);
      await rename(stagingDir, bundleDir).catch(async (error: unknown) => {
        if (!(await exists(readyMarker))) throw error;
      });
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { harness: "pi", version, dir: bundleDir };
}

async function prepareOpenCode(cacheDir: string): Promise<HarnessBundle> {
  const version = PEER_VERSIONS.opencode;
  const archDirs = await fetchArchBinaries({
    cacheDir,
    cachePrefix: `opencode-${version}-linux`,
    binaryName: "opencode",
    archiveExt: ".tgz",
    sha256ForArch: OPENCODE_SHA256,
    urlForArch: (arch) =>
      `https://registry.npmjs.org/@opencode/cli-linux-${arch}/-/cli-linux-${arch}-${version}.tgz`,
    extractArgs: (archivePath, stagingDir) => [
      "-xzf",
      archivePath,
      "-C",
      stagingDir,
      "--strip-components=2",
      "package/bin/opencode",
    ],
  });

  return { harness: "opencode", version, archDirs };
}

async function prepareFx(cacheDir: string): Promise<HarnessBundle> {
  const version = PEER_VERSIONS.fx;
  const archDirs = await fetchArchBinaries({
    cacheDir,
    cachePrefix: `fx-${version}-linux`,
    binaryName: "fx",
    archiveExt: ".tar.gz",
    sha256ForArch: { x64: FX_RELEASES.x64.sha256, arm64: FX_RELEASES.arm64.sha256 },
    urlForArch: (arch) =>
      `https://releases.fx.sh/v${version}/fx-${FX_RELEASES[arch].target}.tar.gz`,
    extractArgs: (archivePath, stagingDir) => ["-xzf", archivePath, "-C", stagingDir, "fx"],
  });

  return { harness: "fx", version, archDirs };
}
