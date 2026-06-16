// Thin ESM re-export shim for the vendored `@vercel/detect-agent` package.
//
// Upstream ships only `dist/index.js` as CommonJS, so rolldown's default
// bundling collapses it into a single default-export object. Pointing the
// vendor pipeline at this wrapper instead surfaces the named export eve
// source uses (`determineAgent`) with no Node CJS named-exports interop on
// the consumer side.
export { determineAgent } from "@vercel/detect-agent";
