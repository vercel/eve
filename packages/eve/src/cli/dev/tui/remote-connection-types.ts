import type { Client, AgentInfoResult } from "#client/index.js";
import type { DevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import type { DevelopmentOidcTokenResolution } from "#services/dev-client/request-headers.js";
import type {
  ResolvedVercelDeployment,
  VercelDeploymentResolution,
} from "#setup/vercel-deployment.js";

import type { RemoteAuthCompletedMutation, RemoteAuthPreparation } from "./remote-auth-result.js";
import type { RemoteDevelopmentTarget } from "./target.js";

export type RemoteAuthChallenge =
  | { readonly kind: "eve-oidc" }
  | { readonly kind: "vercel-deployment-protection" };

interface RemoteRequestFailure {
  readonly message: string;
}

export type RemoteConnectionState =
  | { readonly state: "checking" }
  | { readonly state: "ready"; readonly info: AgentInfoResult }
  | {
      readonly state: "auth-required";
      readonly challenge: RemoteAuthChallenge;
    }
  | {
      readonly state: "authenticating";
      readonly challenge: RemoteAuthChallenge;
    }
  | {
      readonly state: "auth-failed";
      readonly challenge: RemoteAuthChallenge;
    }
  | {
      readonly state: "unavailable";
      readonly failure: RemoteRequestFailure;
    };

export interface RemoteConnectionSnapshot {
  readonly target: RemoteDevelopmentTarget;
  readonly connection: RemoteConnectionState;
  /** Last deployment identity resolved from Vercel for this target. */
  readonly deployment?: ResolvedVercelDeployment;
}

export type RemoteAuthCompletion =
  | { readonly kind: "authenticated" }
  | {
      readonly kind: "cancelled";
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    }
  | {
      readonly kind: "failed";
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly failure: RemoteRequestFailure;
    };

export interface RemoteConnectionController {
  current(): RemoteConnectionSnapshot;
  check(): Promise<RemoteConnectionState>;
  authenticate(
    prepare: (signal: AbortSignal) => Promise<RemoteAuthPreparation>,
    signal?: AbortSignal,
  ): Promise<RemoteAuthCompletion>;
  reportFailure(error: unknown): RemoteConnectionState;
  dispose(): void;
}

export interface RemoteConnectionControllerOptions {
  readonly client: Client;
  readonly credentials: DevelopmentCredentialGate;
  readonly target: RemoteDevelopmentTarget;
  /** Resolves an ambient token only after Vercel proves the exact target origin. */
  readonly resolveOidcToken?: (
    deployment: Pick<ResolvedVercelDeployment, "ownerId" | "projectId">,
  ) => Promise<DevelopmentOidcTokenResolution>;
  readonly resolveDeployment?: (signal: AbortSignal) => Promise<VercelDeploymentResolution>;
  readonly onChange: (snapshot: RemoteConnectionSnapshot) => void;
}
