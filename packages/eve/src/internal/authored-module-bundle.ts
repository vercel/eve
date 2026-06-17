/**
 * Adds actionable context to lower-level authored module bundling failures.
 */
export function createAuthoredModuleBundleError(modulePath: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const hints: string[] = [];

  if (
    /\.node(?:\b|["'?])/i.test(message) ||
    /native addon|native module|invalid utf-?8|Could not load .*\.node/i.test(message)
  ) {
    hints.push(
      "If this comes from a native Node package, keep that package external with agent build.externalDependencies so Vercel/Nitro traces it instead of bundling it.",
    );
  }

  if (
    /Unexpected character|No loader is configured|Could not load|Unknown file extension/i.test(
      message,
    )
  ) {
    hints.push(
      "If this comes from an asset import, eve only supports assets that Rolldown can emit for a Node ESM bundle; otherwise load the file through fs/import.meta.url or externalize the package.",
    );
  }

  return new Error(
    [
      `Failed to bundle authored module "${modulePath}".`,
      message,
      ...hints.map((hint) => `Hint: ${hint}`),
    ].join("\n"),
  );
}
