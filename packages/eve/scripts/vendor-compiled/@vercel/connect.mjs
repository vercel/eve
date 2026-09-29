import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Vendor config for the root `@vercel/connect` entry, which the built-in code
 * extension imports. Its `@vercel/oidc` dependency tree is CommonJS, so it
 * cannot be inlined into eve's `preserveModules` output without a `require`
 * polyfill. A standalone bundle keeps that interop inside this one file.
 *
 * Only the top-level declarations are copied: they describe the root entry and
 * import nothing outside the package. The subpath folders (`eve`, `ai-sdk`,
 * ...) reference optional peers eve does not vendor.
 */
export default {
  packageName: "@vercel/connect",
  compiledPath: "@vercel/connect",
  bundling: "standalone",
  copyDeclarations: createDeclarationCopier({
    files: ({ distEntries }) =>
      distEntries
        .filter((file) => file.endsWith(".d.ts"))
        .sort()
        .map((file) => ({ source: file, output: file })),
  }),
};
