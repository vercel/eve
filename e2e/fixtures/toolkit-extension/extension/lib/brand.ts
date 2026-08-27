// Shared helper: proves an extension bundles its own `extension/lib/` modules into its tools.
export const PROVIDER = "toolkit";

/** Prefixes a value with the provider name, e.g. stamp("forecast-ok-9F4Q"). */
export function stamp(value: string): string {
  return `${PROVIDER}-${value}`;
}
