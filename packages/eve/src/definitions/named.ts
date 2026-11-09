import { eveNamespaceReservation } from "#protocol/runtime-tools.js";

/** What a `defineDynamic()` file returns entries of, and how they're named. */
export interface EntryKind {
  /** What the entries are, as an error names them: `"tool"`. */
  readonly noun: string;
  /** How an author makes one: `"defineTool()"`. */
  readonly made: string;
  readonly is: (value: unknown) => boolean;
  readonly pattern: RegExp;
  readonly qualifiedPattern?: RegExp;
  readonly rule: string;
}

/**
 * The entries a `defineDynamic()` file returned, by name: `null` is none, one entry is named after
 * the file, and a map names each entry by its key, behind the file's extension namespace. No name
 * may take eve's.
 */
export function namedEntries(
  file: {
    readonly logicalPath: string;
    readonly slug: string;
    readonly extensionNamespace?: string;
  },
  value: unknown,
  kind: EntryKind,
): readonly { readonly name: string; readonly entry: unknown }[] {
  const fail = (problem: string) => {
    throw new Error(`The defineDynamic() in "${file.logicalPath}" ${problem}`);
  };
  if (value === null || value === undefined) return [];
  const prefix = file.extensionNamespace === undefined ? "" : `${file.extensionNamespace}__`;
  const single = kind.is(value);
  if (!single && (typeof value !== "object" || Array.isArray(value))) {
    fail(`must return ${kind.made}, a map of ${kind.made} values, or null.`);
  }
  const entries = single ? [[file.slug, value] as const] : Object.entries(value as object);
  return entries.map(([key, entry]) => {
    if (!kind.is(entry)) fail(`returned "${key}" without ${kind.made}.`);
    if (!single && !kind.pattern.test(key))
      fail(`returned illegal ${kind.noun} name "${key}". ${kind.rule}`);
    const name = single ? key : `${prefix}${key}`;
    if (kind.qualifiedPattern !== undefined && !kind.qualifiedPattern.test(name))
      fail(`returned illegal ${kind.noun} name "${name}". ${kind.rule}`);
    const reservation = eveNamespaceReservation(name);
    if (reservation !== undefined) {
      fail(`returned the reserved ${kind.noun} name "${name}". ${reservation}; rename it.`);
    }
    return { entry, name };
  });
}
