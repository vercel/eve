export const SHARED_PRINCIPAL_OPT_IN = "EVE_BUZZ_ALLOW_SHARED_PRINCIPAL";

const CONNECTOR_ONLY_KEYS = [
  "BUZZ_PRIVATE_KEY",
  "BUZZ_AUTH_TAG",
  "BUZZ_API_TOKEN",
  "BUZZ_ACP_PRIVATE_KEY",
  "BUZZ_ACP_API_TOKEN",
  "BUZZ_ACP_RESPOND_TO",
  "BUZZ_ACP_RESPOND_TO_ALLOWLIST",
  SHARED_PRINCIPAL_OPT_IN,
  "NOSTR_PRIVATE_KEY",
] as const;

export function assertSafeBuzzAuthorGate(environment: NodeJS.ProcessEnv): void {
  const mode = environment.BUZZ_ACP_RESPOND_TO;
  if (mode === "owner-only" || mode === "nobody") return;
  if (environment[SHARED_PRINCIPAL_OPT_IN] === "1") return;

  const configuredMode = mode === undefined ? "not available" : `"${mode}"`;
  throw new Error(
    `Buzz author gate is ${configuredMode}. The eve adapter requires "owner-only" because ACP does not carry verified sender identity into eve. Set the Buzz agent's Respond to setting to Owner only, or reinstall with --allow-shared-principal to intentionally let every accepted sender use the same eve authentication and connections.`,
  );
}

export function eveChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  for (const key of CONNECTOR_ONLY_KEYS) delete child[key];
  return child;
}
