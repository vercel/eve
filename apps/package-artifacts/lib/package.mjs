export const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function packageArtifactPath(sourceSha) {
  return `packages/${sourceSha}/eve.tgz`;
}

export function packageManifestPath(sourceSha) {
  return `packages/${sourceSha}/manifest.json`;
}

export function packageDependencyUrl(baseUrl, sourceSha) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("EVE_PACKAGE_BASE_URL must use HTTPS.");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${sourceSha}/eve.tgz`;
  return url.toString();
}

export function packageVersion(stableVersion, sourceSha) {
  const match = stableVersion.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (match === null) throw new Error(`Expected a stable eve version, received ${stableVersion}.`);
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}-main.${sourceSha}`;
}

export function preparePackageJson(packageJson, sourceSha) {
  return { ...packageJson, version: packageVersion(packageJson.version, sourceSha) };
}
