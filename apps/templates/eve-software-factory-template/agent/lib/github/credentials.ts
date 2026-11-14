import { connectGitHubCredentials } from "@vercel/connect/eve";

/**
 * Vercel Connect connector UID for the factory's GitHub App installation.
 *
 * @remarks
 * One connector serves every GitHub surface: the channel (webhooks, replies),
 * the `github` extension's tools, and the brokered git credential the station
 * sandboxes clone, fetch, and push with. The fallback is this template's own
 * connector UID; deployments set `GITHUB_CONNECTOR` to their own.
 */
export const GITHUB_CONNECTOR =
  process.env.GITHUB_CONNECTOR ?? "github/foreman-agent";

/**
 * Connect-managed GitHub App credentials shared by the channel and the git
 * helpers.
 *
 * @remarks
 * Tokens are resolved lazily per use and never exposed to the model; the git
 * helpers inject them only at a fresh transfer sandbox's firewall (see
 * `agent/lib/github/git-transfer.ts`), never in a repository-code station.
 */
export const githubCredentials = connectGitHubCredentials(GITHUB_CONNECTOR);
