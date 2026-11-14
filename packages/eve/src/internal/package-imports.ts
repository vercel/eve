/**
 * Maps eve's own `#compiled/*` and `#*.js` subpath imports, and relative
 * imports between eve's dist modules, to file URLs, the way Node resolves
 * them through eve's package.json `imports` under its default conditions.
 * package-imports.test.ts keeps the two in sync. Other condition sets
 * (`eve-source`) and unusual specifiers are left to Node.
 *
 * This module must not import eve modules: the package-import hook loads it
 * before the hook exists.
 */
const distSourceUrl = new URL("../", import.meta.url).href;
const COMPILED_PREFIX = "#compiled/";

/** Maps one import made by an eve module under `root`, or returns undefined for Node to resolve. */
export function resolveEveDistImport(
  specifier: string,
  parentUrl: string | undefined,
  conditions: readonly string[] | undefined,
  root: string = distSourceUrl,
): string | undefined {
  if (parentUrl?.startsWith(root) !== true) return undefined;
  // Node's package scope ends at `node_modules`, so a dependency inlined under
  // dist/src has no access to eve's imports.
  if (parentUrl.slice(root.length).split("/").includes("node_modules")) return undefined;
  // eve's relative imports stay inside dist/src, where every `.js` file is ESM.
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    if (!specifier.endsWith(".js") || /[\\%?#]/u.test(specifier)) return undefined;
    const url = new URL(specifier, parentUrl).href;
    return url.startsWith(root) ? url : undefined;
  }
  if (specifier[0] !== "#" || conditions?.includes("eve-source") === true) return undefined;
  // Node validates these and reports its own errors.
  if (/[\\%*]|\/\/|(?:^|\/)(?:\.{1,2}|node_modules)(?:\/|$)/u.test(specifier.slice(1))) {
    return undefined;
  }
  // Node picks the pattern with the longest prefix, so `#compiled/*` wins over `#*.js`.
  if (specifier.startsWith(COMPILED_PREFIX)) {
    return new URL(`compiled/${specifier.slice(COMPILED_PREFIX.length)}`, root).href;
  }
  if (specifier.endsWith(".js") && specifier[1] !== "/") {
    return new URL(specifier.slice(1), root).href;
  }
  return undefined;
}
