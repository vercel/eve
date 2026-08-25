import { readFile, writeFile } from "node:fs/promises";

const defaultPackagePath = "packages/eve/package.json";

export function createCanaryVersion(baseVersion, sha) {
  if (!/^\d+\.\d+\.\d+$/u.test(baseVersion)) {
    throw new Error(`invalid base version: ${baseVersion}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`invalid git SHA: ${sha}`);
  }

  const shaPrefix = sha.slice(0, 12);
  const shortId = /^0\d+$/u.test(shaPrefix) ? `g${shaPrefix}` : shaPrefix;
  return `${baseVersion}-${shortId}`;
}

export async function prepareCanaryRelease(sha, packagePath = defaultPackagePath) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (packageJson.name !== "eve") {
    throw new Error(`expected ${packagePath} to describe the eve package`);
  }

  packageJson.version = createCanaryVersion(packageJson.version, sha);
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  return packageJson.version;
}

if (import.meta.main) {
  const [, , sha] = process.argv;
  console.log(await prepareCanaryRelease(sha));
}
