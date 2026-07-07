// Shared helper module for the toolkit extension. Unlike a consumer's own
// `agent/` files (which are snapshotted per-file and import only from packages),
// an extension bundles its own modules — so tools can share code from `ext/lib/`
// instead of repeating it. Imported by toolkit_budget and toolkit_forecast.
export const PROVIDER = "toolkit";

/** Prefixes a value with the provider name, e.g. stamp("forecast-ok-9F4Q"). */
export function stamp(value: string): string {
  return `${PROVIDER}-${value}`;
}
