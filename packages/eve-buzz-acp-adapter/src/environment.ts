const BUZZ_SECRET_KEYS = [
  "BUZZ_PRIVATE_KEY",
  "BUZZ_AUTH_TAG",
  "BUZZ_API_TOKEN",
  "BUZZ_ACP_PRIVATE_KEY",
  "BUZZ_ACP_API_TOKEN",
  "NOSTR_PRIVATE_KEY",
] as const;

export function eveChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  for (const key of BUZZ_SECRET_KEYS) delete child[key];
  return child;
}
