const ALLOWED_CREATE_IN_PLACE_ENTRIES = new Set([
  ".DS_Store",
  ".git",
  ".gitkeep",
  ".hg",
  // mise.toml may need to exist before init so npx runs with the project's Node version.
  "mise.toml",
]);

export function blockingCreateInPlaceEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => !ALLOWED_CREATE_IN_PLACE_ENTRIES.has(entry));
}
