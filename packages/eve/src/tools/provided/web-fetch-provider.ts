/** Web fetch providers available through Vercel AI Gateway. */
export type WebFetchProvider = "browserbase";

/** JSON extraction requires a developer-authored JSON Schema. */
export type WebFetchProviderInput = { readonly provider: WebFetchProvider } & (
  | { readonly format?: "markdown" | "raw"; readonly schema?: never }
  | { readonly format: "json"; readonly schema: Readonly<Record<string, unknown>> }
);

/** Provider-managed fetch configuration for `agent/tools/web_fetch.ts`. */
export type WebFetchProviderDefinition = WebFetchProviderInput & {
  readonly kind: "eve:web-fetch-provider";
};

/**
 * Replaces local web fetch with a provider-managed tool for AI Gateway models.
 * Defaults to Markdown; use `format: "json"` with `schema` for structured extraction
 * or `format: "raw"` for the upstream body. Requires AI Gateway authentication;
 * direct provider models omit this tool.
 *
 * @example
 * ```ts
 * // agent/tools/web_fetch.ts
 * import { webFetchProvider } from "eve/tools/web_fetch";
 * export default webFetchProvider({ provider: "browserbase" });
 * ```
 */
export function webFetchProvider(input: WebFetchProviderInput): WebFetchProviderDefinition {
  return { ...input, kind: "eve:web-fetch-provider" };
}

export function isWebFetchProviderDefinition(value: unknown): value is WebFetchProviderDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "eve:web-fetch-provider"
  );
}
