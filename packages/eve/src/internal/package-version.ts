/**
 * eve's own package version without touching the filesystem.
 *
 * The package build stamps the published version into `dist`
 * (`scripts/stamp-version-tokens.mjs`), so this module is safe to import from
 * workflow-context code, where `node:fs` must never enter the bundle.
 */
const BUNDLED_PACKAGE_VERSION: string = "__EVE_PACKAGE_VERSION__";

/** The stamped package version, or `"0.0.0"` in unstamped source builds. */
export function bundledEveVersion(): string {
  // Detect an unstamped build by the token's `__` shape — spelling the token
  // out in a comparison would get rewritten by the stamp itself.
  return BUNDLED_PACKAGE_VERSION.startsWith("__") ? "0.0.0" : BUNDLED_PACKAGE_VERSION;
}
