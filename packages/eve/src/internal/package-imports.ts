const distSourceUrl = new URL("../", import.meta.url).href;
const COMPILED_PREFIX = "#compiled/";

export function resolveEveDistImport(
  specifier: string,
  parentUrl: string | undefined,
  conditions: readonly string[] | undefined,
  root: string = distSourceUrl,
): string | undefined {
  if (parentUrl?.startsWith(root) !== true) return undefined;
  if (parentUrl.slice(root.length).split("/").includes("node_modules")) return undefined;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    if (!specifier.endsWith(".js") || /[\\%?#]/u.test(specifier)) return undefined;
    const url = new URL(specifier, parentUrl).href;
    return url.startsWith(root) ? url : undefined;
  }
  if (specifier[0] !== "#" || conditions?.includes("eve-source") === true) return undefined;
  if (/[\\%*]|\/\/|(?:^|\/)(?:\.{1,2}|node_modules)(?:\/|$)/u.test(specifier.slice(1))) {
    return undefined;
  }
  if (specifier.startsWith(COMPILED_PREFIX)) {
    return new URL(`compiled/${specifier.slice(COMPILED_PREFIX.length)}`, root).href;
  }
  if (specifier.endsWith(".js") && specifier[1] !== "/") {
    return new URL(specifier.slice(1), root).href;
  }
  return undefined;
}
