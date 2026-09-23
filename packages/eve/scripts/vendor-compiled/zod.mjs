import { loadDeclaration } from "./_shared.mjs";

// Keep this a plain re-export. Zod shares configuration through `globalThis`
// across every copy in a process, so a side-effect import such as
// `zod/compile` would also rewrite the app's own schemas.
export default {
  packageName: "zod",
  compiledPath: "zod",
  chunkGroup: "client",
  declaration: await loadDeclaration("zod.d.ts"),
  platform: "neutral",
};
