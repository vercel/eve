import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { LinuxArch } from "../types.ts";

const execFileAsync = promisify(execFile);

const BENCH_NODE_VERSION = "24.19.0";

const NODE_SHA256: Readonly<Record<LinuxArch, string>> = {
  x64: "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647",
  arm64: "01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc",
};

const LINUX_ARCHES: readonly LinuxArch[] = ["x64", "arm64"];

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function fetchArchBinaries(options: {
  readonly cacheDir: string;
  readonly cachePrefix: string;
  readonly binaryName: string;
  readonly urlForArch: (arch: LinuxArch) => string;
  readonly sha256ForArch?: Readonly<Record<LinuxArch, string>>;
  readonly archiveExt: ".tar.xz" | ".tar.gz" | ".tgz";
  readonly extractArgs: (archivePath: string, stagingDir: string, arch: LinuxArch) => string[];
}): Promise<Record<LinuxArch, string>> {
  await mkdir(options.cacheDir, { recursive: true });
  const entries = await Promise.all(
    LINUX_ARCHES.map(async (arch) => {
      const destDir = join(options.cacheDir, `${options.cachePrefix}-${arch}`);
      const binPath = join(destDir, options.binaryName);
      if (await exists(binPath)) {
        return [arch, destDir] as const;
      }

      const stagingDir = join(
        options.cacheDir,
        `${options.cachePrefix}-${arch}.tmp-${randomUUID().slice(0, 8)}`,
      );
      const archivePath = `${stagingDir}${options.archiveExt}`;

      try {
        await mkdir(stagingDir, { recursive: true });
        const url = options.urlForArch(arch);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
        }
        await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));

        const expectedSha = options.sha256ForArch?.[arch];
        if (expectedSha) {
          const actualSha = await sha256File(archivePath);
          if (actualSha !== expectedSha) {
            throw new Error(
              `${options.binaryName} ${arch} SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`,
            );
          }
        }

        await execFileAsync("tar", options.extractArgs(archivePath, stagingDir, arch), {
          maxBuffer: 16 * 1024 * 1024,
        });
        await chmod(join(stagingDir, options.binaryName), 0o755);

        await rename(stagingDir, destDir).catch(async (error: unknown) => {
          if (!(await exists(binPath))) throw error;
        });
        return [arch, destDir] as const;
      } finally {
        await rm(archivePath, { force: true }).catch(() => {});
        await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  return Object.fromEntries(entries) as Record<LinuxArch, string>;
}

export async function ensureNodeRuntime(cacheDir: string): Promise<Record<LinuxArch, string>> {
  return fetchArchBinaries({
    cacheDir,
    cachePrefix: `node-v${BENCH_NODE_VERSION}`,
    binaryName: "node",
    archiveExt: ".tar.xz",
    sha256ForArch: NODE_SHA256,
    urlForArch: (arch) =>
      `https://nodejs.org/dist/v${BENCH_NODE_VERSION}/node-v${BENCH_NODE_VERSION}-linux-${arch}.tar.xz`,
    extractArgs: (archivePath, stagingDir, arch) => [
      "-xJf",
      archivePath,
      "-C",
      stagingDir,
      "--strip-components=2",
      `node-v${BENCH_NODE_VERSION}-linux-${arch}/bin/node`,
    ],
  });
}
