/**
 * Builds an optional caller allowlist from a comma-separated environment
 * variable. When the variable is empty, everyone the channel admits may
 * invoke the agent, and the GitHub App's installed repositories in Vercel
 * Connect remain the access boundary. Entries are matched case-insensitively.
 */
export function allowlist(value: string | undefined): (id: string | undefined) => boolean {
  const entries = new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  if (entries.size === 0) return () => true;
  return (id) => id !== undefined && entries.has(id.toLowerCase());
}
