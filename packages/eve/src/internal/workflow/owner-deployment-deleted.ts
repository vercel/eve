import { walkCauseChain } from "#shared/errors.js";

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
