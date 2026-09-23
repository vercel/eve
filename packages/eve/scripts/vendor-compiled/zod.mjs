import { loadDeclaration } from "./_shared.mjs";

/**
 * eve ships exactly one Zod. Other vendored bundles and eve's own build
 * (`build-rolldown.mjs`) import these entries instead of bundling their own
 * copy, because Zod schema objects only work with the copy that built them. Keep this a plain re-export: Zod shares configuration through
 * `globalThis` across every copy in a process, so a side-effect import such
 * as `zod/compile` would also rewrite the app's own schemas.
 */
export default {
  packageName: "zod",
  compiledPath: "zod",
  chunkGroup: "client",
  entries: [
    { declaration: await loadDeclaration("zod.d.ts"), input: "zod", outputPath: "index" },
    { input: "zod/v4/core", outputPath: "v4/core" },
    { input: "zod/v3", outputPath: "v3" },
  ],
  platform: "neutral",
  sharedSpecifiers: { zod: "index", "zod/v3": "v3", "zod/v4": "index", "zod/v4/core": "v4/core" },
};
