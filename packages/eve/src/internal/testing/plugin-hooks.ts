type HookName = "load" | "resolveId" | "transform";

type Hook =
  | ((...args: unknown[]) => unknown)
  | { readonly filter?: { readonly id?: unknown }; handler(...args: unknown[]): unknown };

function matchesFilter(filter: unknown, id: string): boolean {
  if (filter === undefined) return true;
  if (filter instanceof RegExp) return filter.test(id);
  if (Array.isArray(filter)) return filter.some((pattern) => matchesFilter(pattern, id));
  const { exclude, include } = filter as { readonly exclude?: unknown; readonly include?: unknown };
  return (
    (exclude === undefined || !matchesFilter(exclude, id)) &&
    (include === undefined || matchesFilter(include, id))
  );
}

/**
 * Calls one build-plugin hook as Rolldown does: an object hook runs only when
 * its RegExp id filter matches the id with `/` separators. Returns null when
 * the hook is absent, filtered out, or declines.
 */
export async function callPluginHook(
  plugin: object,
  hook: HookName,
  ...args: unknown[]
): Promise<unknown> {
  const value = (plugin as Partial<Record<HookName, Hook>>)[hook];
  if (value === undefined) return null;
  const { filter, handler } =
    typeof value === "function" ? { filter: undefined, handler: value } : value;
  const id = String(hook === "transform" ? args[1] : args[0]).replaceAll("\\", "/");
  if (!matchesFilter(filter?.id, id)) return null;
  return (await handler.call({}, ...args)) ?? null;
}
