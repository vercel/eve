import { walkCauseChain } from "#shared/errors.js";

/**
 * Whether Vercel refused a run's payload key because the deployment that
 * started the run was deleted. Vercel replays a run only on its own
 * deployment, so that run can never execute again. Matched by shape: the
 * World does not export its error class. Anything else, including other 404s,
 * stays an ordinary failure, because misreading a live owner as deleted would
 * end its session.
 */
export function isOwnerDeploymentDeletedError(error: unknown): boolean {
  for (const cause of walkCauseChain(error)) {
    if (
      cause instanceof Error &&
      cause.name === "RunKeyFetchError" &&
      (cause as { readonly status?: unknown }).status === 404 &&
      cause.message.includes("Deployment not found")
    ) {
      return true;
    }
  }
  return false;
}
