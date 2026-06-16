import { loadDeclaration } from "./_shared.mjs";

/**
 * Vendor config for `chokidar` v5. v5 dropped the optional `fsevents`
 * native binding (already gone in v4) and relies entirely on `fs.watch`,
 * so the bundle has no native dependencies to stub. `readdirp` is the
 * only transitive dependency and rolldown's normal graph walk inlines it.
 *
 * The declaration is hand-authored because the upstream `index.d.ts`
 * imports from `readdirp` (an external) and `./handler.js` (a sibling
 * file we don't co-vendor); copying the upstream tree would pull in
 * machinery eve never touches. Only the `watch` entry and its return
 * surface are needed by the dev-authored source watcher.
 */
export default {
  packageName: "chokidar",
  compiledPath: "chokidar",
  bundling: "standalone",
  declaration: await loadDeclaration("chokidar.d.ts"),
};
