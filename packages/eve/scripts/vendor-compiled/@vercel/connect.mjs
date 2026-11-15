import { createDeclarationCopier } from "../_shared.mjs";

/**
 * Vendor config for the root `@vercel/connect` entry, which the built-in code
 * extension imports. It shares its CommonJS `@vercel/oidc` tree with the
 * vendored `@vercel/oidc` through the node chunk group.
 *
 * Only the top-level declarations are copied: they describe the root entry and
 * import nothing outside the package. The subpath folders (`eve`, `ai-sdk`,
 * ...) reference optional peers eve does not vendor.
 */
export default {
  packageName: "@vercel/connect",
  compiledPath: "@vercel/connect",
  copyDeclarations: createDeclarationCopier({
    files: ({ distEntries }) =>
      distEntries
        .filter((file) => file.endsWith(".d.ts"))
        .sort()
        .map((file) => ({ source: file, output: file })),
  }),
};
