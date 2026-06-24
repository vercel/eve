import type { VerifiedVercelTarget } from "#setup/vercel-deployment.js";

export type RemoteAuthCompletedMutation = { readonly kind: "vercel-login" };

export type RemoteAuthPreparation =
  | {
      readonly kind: "prepared";
      readonly target: VerifiedVercelTarget;
      readonly resolveToken: () => Promise<string>;
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    }
  | {
      readonly kind: "cancelled";
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    };

/** Human-readable actions that completed and cannot be rolled back automatically. */
export function describeRemoteAuthCompletedMutations(
  completedMutations: readonly RemoteAuthCompletedMutation[],
): string[] {
  return completedMutations.map((mutation) => {
    switch (mutation.kind) {
      case "vercel-login":
        return "logged in to Vercel";
    }
  });
}

/** Adds the mutations that cannot be rolled back to an authentication failure. */
export function appendRemoteAuthMutationSummary(
  message: string,
  completedMutations: readonly RemoteAuthCompletedMutation[],
): string {
  const completed = describeRemoteAuthCompletedMutations(completedMutations);
  return completed.length === 0
    ? message
    : `${message} Completed before the failure: ${completed.join(", ")}.`;
}
