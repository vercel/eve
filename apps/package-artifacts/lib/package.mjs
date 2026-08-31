export const SHA_PATTERN = /^[0-9a-f]{40}$/i;
export const PULL_REQUEST_PATTERN = /^[1-9]\d*$/;

export function packageArtifactPath(sourceSha) {
  return `packages/${sourceSha}/eve.tgz`;
}

export function packageManifestPath(sourceSha) {
  return `packages/${sourceSha}/manifest.json`;
}

export function packagePointerPath(ref) {
  if (ref === "main") return "packages/refs/main.json";
  if (PULL_REQUEST_PATTERN.test(ref)) return `packages/refs/pr/${ref}.json`;
  throw new Error("Package ref must be main or a positive pull request number.");
}

export function packageDependencyUrl(baseUrl, sourceSha) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("Package base URL must use HTTPS.");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${sourceSha}/eve.tgz`;
  return url.toString();
}

export function packageVersion(stableVersion, sourceSha, channel = "main") {
  const match = stableVersion.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (match === null) throw new Error(`Expected a stable eve version, received ${stableVersion}.`);
  return `${stableVersion}+${channel}.${sourceSha}`;
}

export function preparePackageJson(packageJson, sourceSha, channel) {
  return { ...packageJson, version: packageVersion(packageJson.version, sourceSha, channel) };
}
