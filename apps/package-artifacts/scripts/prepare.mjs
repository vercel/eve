import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PULL_REQUEST_PATTERN,
  SHA_PATTERN,
  packageDependencyUrl,
  preparePackageJson,
} from "../lib/package.mjs";
import { packPackage } from "../lib/pack.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const packageRoot = join(repoRoot, "packages/eve");
const packageJsonPath = join(packageRoot, "package.json");
const sourceSha = process.env.EVE_PACKAGE_SOURCE_SHA;
const ref = process.env.EVE_PACKAGE_REF;
const packageOrigin = process.env.EVE_PACKAGE_PUBLIC_ORIGIN;
const outputDirectory = resolve(process.env.EVE_PACKAGE_OUTPUT_DIRECTORY ?? "package-artifact");

if (!SHA_PATTERN.test(sourceSha ?? "")) {
  throw new Error("EVE_PACKAGE_SOURCE_SHA must be a 40-character Git commit SHA.");
}
if (ref !== "main" && !PULL_REQUEST_PATTERN.test(ref ?? "")) {
  throw new Error("EVE_PACKAGE_REF must be main or a positive pull request number.");
}
if (typeof packageOrigin !== "string" || packageOrigin.length === 0) {
  throw new Error("EVE_PACKAGE_PUBLIC_ORIGIN is required.");
}

const originalPackageJson = await readFile(packageJsonPath, "utf8");
const preparedPackageJson = preparePackageJson(JSON.parse(originalPackageJson), sourceSha, "git");
const dependencyUrl = packageDependencyUrl(packageOrigin, sourceSha);

try {
  await writeFile(packageJsonPath, `${JSON.stringify(preparedPackageJson, null, 2)}\n`);
  const tarball = await packPackage(packageRoot, preparedPackageJson.version, {
    ...process.env,
    EVE_PACKAGE_DEPENDENCY_URL: dependencyUrl,
  });
  const metadata = {
    sourceSha,
    ref,
    version: preparedPackageJson.version,
    tarball: dependencyUrl,
    sha256: createHash("sha256").update(tarball).digest("hex"),
  };

  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "eve.tgz"), tarball);
  await writeFile(join(outputDirectory, "metadata.json"), `${JSON.stringify(metadata)}\n`);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
} finally {
  await writeFile(packageJsonPath, originalPackageJson);
}
