// Preparing a development build's sandbox templates on first use, in Node, where `eve dev` writes
// that build to disk. The module stays where it is because deployed Nitro builds prune it by
// path; `development-sandboxes.web.ts` is the twin for runtimes with no development build, and
// the package's `#platform/*` imports pick one by the `node` condition.
export { ensureDevelopmentSandboxesPrepared } from "#execution/sandbox/development-lazy-prewarm.js";
