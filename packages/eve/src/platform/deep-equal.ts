// Structural equality for the data eve compares (model messages, schedule payloads): Node's own
// `util.isDeepStrictEqual`. `deep-equal.web.ts` is the browser's twin; the package's `#platform/*`
// imports pick one by the `node` condition.
export { isDeepStrictEqual } from "node:util";
