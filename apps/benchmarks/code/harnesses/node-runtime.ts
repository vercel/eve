import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const BENCH_NODE_VERSION = "24.19.0";
export type LinuxArch = "x64" | "arm64";
export const LINUX_ARCHES: readonly LinuxArch[] = ["x64", "arm64"];

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function ensureNodeRuntime(
  cacheDir: string,
  version: string = BENCH_NODE_VERSION,
): Promise<Record<LinuxArch, string>> {
  const root = join(cacheDir, `node-v${version}`);
  await mkdir(root, { recursive: true });
  const entries = await Promise.all(
    LINUX_ARCHES.map(async (arch) => {
      const dest = join(root, arch);
      if (await exists(join(dest, "node"))) {
        return [arch, dest] as const;
      }
      const filename = `node-v${version}-linux-${arch}.tar.xz`;
      const url = `https://nodejs.org/dist/v${version}/${filename}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
      }
      const archive = join(root, `${filename}.${randomUUID()}.download`);
      const staging = `${dest}.${randomUUID()}.staging`;
      try {
        await writeFile(archive, Buffer.from(await response.arrayBuffer()));
        await mkdir(staging, { recursive: true });
        await exec("tar", [
          "-xJf",
          archive,
          "-C",
          staging,
          "--strip-components=2",
          `node-v${version}-linux-${arch}/bin/node`,
        ]);
        await chmod(join(staging, "node"), 0o755);
        await rename(staging, dest).catch(async (error: unknown) => {
          if (!(await exists(join(dest, "node")))) throw error;
        });
      } finally {
        await rm(archive, { force: true });
        await rm(staging, { recursive: true, force: true });
      }
      return [arch, dest] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<LinuxArch, string>;
}
