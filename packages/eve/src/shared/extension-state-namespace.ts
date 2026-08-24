/**
 * Derives the namespace that scopes an extension's durable state keys and config
 * binding from its package name. The package identity remains stable when a
 * consumer renames its mount.
 */
export function packageStateNamespace(packageName: string): string {
  return (
    packageName
      .replace(/^@/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "extension"
  );
}
