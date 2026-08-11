import { readFile } from "node:fs/promises";
import { join } from "node:path";

const registryPath = join("apps", "docs", "registry.json");
const evePackagePath = join("packages", "eve", "package.json");
const minimumVersionPattern = /^>=(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

function parseVersion(version, pattern) {
  const match = pattern.exec(version);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease.localeCompare(right.prerelease, "en");
}

export function validatePublicRegistryRequirements(registry, eveVersion) {
  const published = parseVersion(eveVersion, versionPattern);
  if (published === undefined)
    throw new Error(`invalid Eve package version: ${String(eveVersion)}`);
  if (!Array.isArray(registry?.items)) throw new Error("registry must contain an items array");

  const errors = [];
  for (const item of registry.items) {
    const requirement = item?.meta?.eve?.requires;
    if (requirement === undefined) continue;
    const minimum = parseVersion(requirement, minimumVersionPattern);
    if (minimum === undefined) {
      errors.push(`${item.name}: unsupported Eve requirement ${JSON.stringify(requirement)}`);
    } else if (compareVersions(minimum, published) > 0) {
      errors.push(`${item.name}: requires ${requirement}, but packages/eve is ${eveVersion}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      [
        "apps/docs/registry.json must not require an unpublished Eve version.",
        ...errors,
        "Add affected items to apps/docs/registry.staged-requirements.json; the Changesets release process will materialize them after selecting the Eve version.",
      ].join("\n"),
    );
  }
}

export async function validatePublicRegistryRequirementsFromFiles(paths = {}) {
  const resolvedRegistryPath = paths.registryPath ?? registryPath;
  const resolvedEvePackagePath = paths.packagePath ?? evePackagePath;
  const [registryText, packageText] = await Promise.all([
    readFile(resolvedRegistryPath, "utf8"),
    readFile(resolvedEvePackagePath, "utf8"),
  ]);
  validatePublicRegistryRequirements(JSON.parse(registryText), JSON.parse(packageText).version);
}

if (import.meta.main) await validatePublicRegistryRequirementsFromFiles();
