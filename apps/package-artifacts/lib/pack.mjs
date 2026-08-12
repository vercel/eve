import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function packPackage(packageRoot, version, env = process.env) {
  const workDirectory = await mkdtemp(join(tmpdir(), "eve-package-artifacts-"));
  const pnpmTarballPath = join(workDirectory, "pnpm.tgz");
  const extractedDirectory = join(workDirectory, "extracted");
  const finalDirectory = join(workDirectory, "final");

  try {
    await execFile("pnpm", ["--dir", packageRoot, "pack", "--out", pnpmTarballPath], { env });
    await mkdir(extractedDirectory);
    await execFile("tar", ["-xzf", pnpmTarballPath, "-C", extractedDirectory]);

    const packedPackageRoot = join(extractedDirectory, "package");
    const packedPackageJsonPath = join(packedPackageRoot, "package.json");
    const packedPackageJson = JSON.parse(await readFile(packedPackageJsonPath, "utf8"));
    packedPackageJson.version = version;
    await writeFile(packedPackageJsonPath, `${JSON.stringify(packedPackageJson, null, 2)}\n`);

    await mkdir(finalDirectory);
    const { stdout } = await execFile(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", finalDirectory],
      { cwd: packedPackageRoot, env },
    );
    const [packResult] = JSON.parse(stdout);
    if (typeof packResult?.filename !== "string") {
      throw new Error("npm pack did not report a tarball filename.");
    }
    if (packResult.version !== version) {
      throw new Error(
        `Expected packed version ${version}, received ${String(packResult.version)}.`,
      );
    }
    return readFile(join(finalDirectory, packResult.filename));
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
}
