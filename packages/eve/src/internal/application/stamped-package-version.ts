// The package build stamps the published version into `dist` so bundled
// deployments can report package metadata without resolving package.json.
const STAMPED_PACKAGE_VERSION: string = "__EVE_PACKAGE_VERSION__";

/**
 * Returns the build-stamped eve version, or undefined for an unstamped build
 * compiled from source.
 */
export function readStampedPackageVersion(): string | undefined {
  // Detect an unstamped build by the token's `__` shape. Spelling the token
  // out in a comparison would get rewritten by the stamp itself.
  return STAMPED_PACKAGE_VERSION.startsWith("__") ? undefined : STAMPED_PACKAGE_VERSION;
}
