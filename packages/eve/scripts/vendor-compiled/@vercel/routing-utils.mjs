import { loadDeclaration } from "../_shared.mjs";

export default {
  packageName: "@vercel/routing-utils",
  compiledPath: "@vercel/routing-utils",
  bundling: "standalone",
  declaration: await loadDeclaration("@vercel/routing-utils.d.ts"),
};
