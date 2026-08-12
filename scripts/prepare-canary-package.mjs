import { readFile, writeFile } from "node:fs/promises";

const packageJsonPath = new URL("../packages/eve/package.json", import.meta.url);
const sha = process.env.EVE_CANARY_SHA;

if (!/^[0-9a-f]{40}$/i.test(sha ?? "")) {
  throw new Error("EVE_CANARY_SHA must be a 40-character Git commit SHA.");
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const match = packageJson.version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
if (match === null) {
  throw new Error(
    `eve package version must be a stable SemVer version, received ${packageJson.version}.`,
  );
}

const [, major, minor, patch] = match;
packageJson.version = `${major}.${minor}.${Number(patch) + 1}-canary.${sha}`;

await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
