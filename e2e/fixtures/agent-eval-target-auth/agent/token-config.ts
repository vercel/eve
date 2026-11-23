/**
 * Fixture-only signing settings shared by the target's verifier and the eval
 * config's token minter. Tokens live a few seconds, so any eval that reuses
 * one token across turns sees it expire.
 */
export const TOKEN = {
  audience: "agent-eval-target-auth",
  issuer: "https://auth.fixture.invalid",
  lifetimeSeconds: 3,
  secret: "agent-eval-target-auth-fixture-secret",
  subject: "alice",
} as const;
