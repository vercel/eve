import type { VerifiedVercelTarget } from "#setup/vercel-deployment.js";

export type RemoteAuthCompletedMutation =
  | { readonly kind: "vercel-login" }
  | {
      readonly kind: "trusted-sources-updated";
      readonly targetProjectName: string;
    };

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
      case "trusted-sources-updated":
        return `updated Trusted Sources for ${mutation.targetProjectName}`;
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

/** Formats a Vercel Deployment Protection challenge for the remote TUI. */
export function formatRemoteAuthChallengeMessage(serverUrl: string): string {
  return [
    `Vercel Deployment Protection blocked the request to ${serverUrl}.`,
    "",
    "To access the deployment from `eve dev`, do one of:",
    "  • Run `/vc:login` to authenticate this remote via Vercel OIDC.",
    "  • Set VERCEL_AUTOMATION_BYPASS_SECRET to a Protection Bypass for",
    "    Automation token (Project Settings → Deployment Protection).",
    "  • Disable Deployment Protection on the target deployment.",
    "",
    "Docs: https://vercel.com/docs/deployment-protection",
  ].join("\n");
}
