/** Label prefixing the framework-injected authorization-resume notice. */
export const AUTHORIZATION_UPDATE_LABEL = "[Authorization update]";

/** True when text is the framework-injected authorization-resume notice. */
export function isAuthorizationResumeSnippet(text: string): boolean {
  return text.startsWith(AUTHORIZATION_UPDATE_LABEL);
}

/**
 * Renders the model-visible projection of a partial authorization batch.
 * Only connection names are included; callback payloads and challenge data
 * remain framework-private.
 */
export function renderAuthorizationResumeSnippet(input: {
  readonly authorized: readonly string[];
  readonly pending: readonly string[];
}): string {
  const authorized = [...new Set(input.authorized)];
  const pending = [...new Set(input.pending)];

  return [
    AUTHORIZATION_UPDATE_LABEL,
    "Authorization completed for:",
    ...authorized.map((name) => JSON.stringify({ name })),
    ...(pending.length === 0
      ? ["No authorization requests remain pending."]
      : [
          "The following connections are still awaiting authorization. Do not retry them until their callbacks arrive:",
          ...pending.map((name) => JSON.stringify({ name })),
        ]),
    "Continue based on this updated authorization state.",
  ].join("\n");
}
