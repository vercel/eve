/**
 * Experimental: eve in a browser page or Web Worker. The embed API every host has (the list
 * `eve/experimental/embed` re-exports too) plus what a page needs: a World in IndexedDB to keep
 * its sessions, and tools in the same import. Any bundler builds it with no configuration: nothing it reaches
 * imports a Node built-in or names a Node global (`scripts/browser-reach.mjs` holds both at 0),
 * and `#platform/*` picks the browser's twins by the `node` condition.
 *
 * A browser has no AsyncLocalStorage, so a step's tool calls run one at a time here.
 * `memorySandbox()` keeps the shell's files in IndexedDB, per session. APIs may change without
 * notice.
 */
export * from "#public/experimental/embed/shared.js";
// What a page adds: a World in its IndexedDB, and `defineTool` and `always` in the same import
// (`eve/tools/approval` reaches Node globals, so a page can't take `always` from there).
export { indexedDbWorld as browserWorld } from "#browser/indexed-db-world.js";
export { defineTool } from "#tools/definition.js";
export { always } from "#tools/approval/policies.js";
