/**
 * Reads a required environment variable and reports an actionable setup error.
 *
 * @param name - Exact environment variable name to read.
 * @param example - Non-secret example displayed when the variable is missing.
 * @returns The configured, nonempty value without trimming it.
 * @throws {@link Error} When the variable is unset or empty.
 */
export const requireEnv = (name: string, example: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} environment variable is not set. Set it to a value like '${example}'.`
    );
  }
  return value;
};
