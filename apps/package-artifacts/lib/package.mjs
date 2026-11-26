export const SHA_PATTERN = /^[0-9a-f]{40}$/i;
export const PULL_REQUEST_PATTERN = /^[1-9]\d*$/;
export const PACKAGE_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PACKAGE_VERSION_SHA_LENGTH = 16;

export function packageSlug(name) {
  const slug = name.replace(/^@/, "").replace("/", "-");
  if (!PACKAGE_SLUG_PATTERN.test(slug)) throw new Error(`Unsupported package name ${name}.`);
  return slug;
}

export function packageArtifactPath(sourceSha, slug) {
  return `packages/${sourceSha}/${slug}.tgz`;
}

export function packageManifestPath(sourceSha) {
  return `packages/${sourceSha}/manifest.json`;
}

export function packagePointerPath(ref) {
  if (ref === "main") return "packages/refs/main.json";
  if (PULL_REQUEST_PATTERN.test(ref)) return `packages/refs/pr/${ref}.json`;
  throw new Error("Package ref must be main or a positive pull request number.");
}

export function packageDependencyUrl(baseUrl, sourceSha, slug) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("Package base URL must use HTTPS.");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${sourceSha}/${slug}.tgz`;
  return url.toString();
}

export function packageVersion(releaseVersion, sourceSha, channel = "main") {
  const match = releaseVersion.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
  );
  if (match === null) {
    throw new Error(
      `Expected a release version without build metadata, received ${releaseVersion}.`,
    );
  }
  return `${releaseVersion}+${channel}.${sourceSha.slice(0, PACKAGE_VERSION_SHA_LENGTH)}`;
}

export function preparePackageJson(packageJson, sourceSha, channel) {
  return { ...packageJson, version: packageVersion(packageJson.version, sourceSha, channel) };
}

export function publishablePackages(packageJsons) {
  const packages = packageJsons
    .filter((packageJson) => packageJson.private !== true)
    .map((packageJson) => ({ ...packageJson, slug: packageSlug(packageJson.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const slugs = new Set(packages.map(({ slug }) => slug));
  if (slugs.size !== packages.length) throw new Error("Package artifact names must be unique.");
  if (!slugs.has("eve")) throw new Error("The eve package must be publishable.");
  return packages;
}

export function packageManifest(sourceSha, packages) {
  const entries = Object.fromEntries(
    packages.map(({ name, version, tarball, sha256 }) => [name, { version, tarball, sha256 }]),
  );
  return { sourceSha, ...entries.eve, packages: entries };
}

export function manifestPackages(manifest) {
  const { version, tarball, sha256 } = manifest;
  return manifest.packages ?? { eve: { version, tarball, sha256 } };
}
