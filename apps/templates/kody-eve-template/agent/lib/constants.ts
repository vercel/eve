import { connect } from "@vercel/connect/eve";

/**
 * Reads a required environment variable, throwing if it is unset so
 * misconfiguration fails fast instead of surfacing mid-request.
 *
 * @remarks
 * Call it at module load when the value is needed for discovery (connector
 * UIDs, channel credentials), or inside a handler when a missing value
 * should not prevent the rest of the agent from loading.
 *
 * @param name - The environment variable name.
 * @param example - An example value, included in the error message.
 * @returns The environment variable's value.
 */
export function requireEnv(name: string, example: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} environment variable is not set (e.g. '${example}').`
    );
  }
  return value;
}

/**
 * Shared Linear authorization via Vercel Connect.
 *
 * Single source of truth for the Linear connector so every consumer — the
 * Linear MCP connection and any tool calling the GraphQL API directly —
 * shares one Linear installation and one set of scopes.
 *
 * @remarks
 * - App-scoped (`principalType: "app"`), so no per-user consent flow is
 *   required; tokens are minted for the installation itself.
 * - Tokens are requested per call via `ctx.getToken(linearAuth)`, cached per
 *   step by eve, and never exposed to the model.
 * - The connector UID comes from the `LINEAR_CONNECTOR` environment variable
 *   (e.g. `linear/kody-agent`); the module throws at load time if it
 *   is not set.
 *
 * @example
 * ```ts
 * const { token } = await ctx.getToken(linearAuth);
 * ```
 */
export const linearAuth = connect({
  connector: requireEnv("LINEAR_CONNECTOR", "linear/kody-agent"),
  principalType: "app",
  tokenParams: {
    scopes: ["read", "write", "issues:create", "comments:create"],
  },
});
