import { loadDeclaration } from "./_shared.mjs";

/**
 * Vendor config for `gray-matter` v4. Upstream is CommonJS
 * (`module.exports = matter`) and its `.d.ts` uses the legacy
 * `export = matter` ambient-module form. Rolldown converts the CJS
 * default into an ESM default export, but the upstream declaration
 * cannot be vendored as-is for ESM consumers.
 *
 * A hand-authored ESM-style declaration covers the call signatures and
 * static methods (`matter()`, `matter.test()`) eve actually uses. The
 * surface is small and upstream is dormant (last release 2019), so
 * curated declarations have a much lower drift risk than for actively
 * developed packages.
 */
export default {
  packageName: "gray-matter",
  compiledPath: "gray-matter",
  bundling: "standalone",
  declaration: await loadDeclaration("gray-matter.d.ts"),
};
