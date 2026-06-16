import { createHmac, timingSafeEqual } from "node:crypto";

import { createLogger } from "#internal/logging.js";
import {
  resolveGitHubWebhookSecret,
  type GitHubWebhookSecret,
} from "#public/channels/github/auth.js";

const log = createLogger("github.verify");

/**
 * Caller-supplied inbound webhook verifier. Use it as an alternative to HMAC
 * verification. For example, Connect supplies a verifier that authenticates
 * Connect-forwarded webhooks with Vercel OIDC instead of GitHub's webhook
 * secret.
 *
 * Contract (matches the other channels' `webhookVerifier`):
 *
 * - **Throw / reject** → the channel responds 401 to GitHub.
 * - **Return a falsy value** (`null` / `undefined` / `false` / `""` / `0`)
 *   → the channel responds 401 to GitHub. This lets verifiers signal
 *   rejection without throwing. For example, Connect's `vercelOidc()` returns
 *   `null` on a failed OIDC check.
 * - **Return a truthy non-string value** → verification accepted.
 * - **Return a string** → verification accepted, and the string replaces
 *   the raw body for downstream parsing.
 */
export type GitHubWebhookVerifier = (request: Request, body: string) => unknown | Promise<unknown>;

/** Options for {@link verifyGitHubRequest}. */
export interface GitHubVerifyOptions {
  readonly webhookSecret?: GitHubWebhookSecret;
  readonly webhookVerifier?: GitHubWebhookVerifier;
}

/**
 * Verifies a GitHub webhook request and returns its raw body. The raw body is
 * required because GitHub signs the exact bytes it delivered.
 *
 * When a {@link GitHubWebhookVerifier} is supplied, it replaces the built-in
 * HMAC check: GitHub's webhook secret is never read and the verifier owns the
 * accept/reject decision.
 */
export async function verifyGitHubRequest(
  request: Request,
  options: GitHubVerifyOptions,
): Promise<string> {
  const body = await request.text();

  if (options.webhookVerifier !== undefined) {
    const result = await options.webhookVerifier(request, body);
    if (!result) {
      throw new Error("githubChannel: inbound webhook verifier rejected the request.");
    }
    return typeof result === "string" ? result : body;
  }

  const secret = await resolveGitHubWebhookSecret(options.webhookSecret);
  const signatureHeader = request.headers.get("x-hub-signature-256") ?? "";
  if (!signatureHeader) {
    throw new Error("githubChannel: inbound request missing X-Hub-Signature-256.");
  }
  const expected = signGitHubWebhookBody(body, secret);
  if (!constantTimeCompare(expected, signatureHeader)) {
    throw new Error("githubChannel: inbound request signature mismatch.");
  }
  return body;
}

/** Signs a raw GitHub webhook body for tests and local fixtures. */
export function signGitHubWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (error) {
    log.debug("timingSafeEqual threw", { error });
    return false;
  }
}
