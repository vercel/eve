export const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function canaryArtifactPath(sourceSha, version) {
  return `canary/${sourceSha}/eve-${version}.tgz`;
}

export function canaryDependencyUrl(storeId, sourceSha, version) {
  const host = storeId.replace(/^store_/, "").toLowerCase();
  return `https://${host}.public.blob.vercel-storage.com/${canaryArtifactPath(sourceSha, version)}`;
}

export function canaryVersion(stableVersion, sourceSha) {
  const match = stableVersion.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (match === null) throw new Error(`Expected a stable eve version, received ${stableVersion}.`);
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}-canary.${sourceSha}`;
}
