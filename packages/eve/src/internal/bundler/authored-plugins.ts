import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "rolldown";

import { createAuthoredAssetImportPlugin } from "#internal/authored-asset-import-plugin.js";
import { RESOLVE_EXTENSIONS } from "#internal/authored-package-boundary.js";
import { createAuthoredPackageTsConfigPathsPlugin } from "#internal/authored-package-tsconfig-paths.js";
import { createAuthoredRelativeExtensionResolverPlugin } from "#internal/authored-relative-extension-resolver.js";

export interface AuthoredPluginsInput {
  /** The authored package: asset imports stay inside it, and its tsconfig resolves aliases. */
  readonly packageRoot: string;
  /**
   * For builds that also bundle installed dependencies, the workflow driver
   * and the Nitro host: eve resolves imports from authored source only and
   * leaves dependency imports to the bundler.
   */
  readonly authoredSourceOnly?: boolean;
  readonly extensions?: readonly string[];
}

/**
 * How every eve build resolves authored source: authored module bundles,
 * extension distributions, the workflow driver, and the Nitro host. Callers
 * put their own plugins around this list, never inside it.
 */
export function createAuthoredPlugins(input: AuthoredPluginsInput): Plugin[] {
  const authoredSourceOnly = input.authoredSourceOnly ?? false;
  const extensions = input.extensions ?? RESOLVE_EXTENSIONS;
  return [
    // First, so no other resolver claims an asset import before its package-root check.
    createAuthoredAssetImportPlugin({ authoredSourceOnly, packageRoot: input.packageRoot }),
    createAuthoredRelativeExtensionResolverPlugin({ authoredSourceOnly, extensions }),
    createAuthoredPackageTsConfigPathsPlugin({
      appPackageRoot: input.packageRoot,
      authoredSourceOnly,
      extensions,
    }),
  ];
}

/**
 * The one tsconfig every build of the authored package reads: its own
 * `tsconfig.json` or `jsconfig.json`. Sources in other workspace packages get
 * their own package's `paths` from {@link createAuthoredPlugins}.
 */
export function resolveAuthoredTsConfigPath(packageRoot: string): string | false {
  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    const path = join(packageRoot, fileName);
    if (existsSync(path)) {
      return path;
    }
  }
  return false;
}
