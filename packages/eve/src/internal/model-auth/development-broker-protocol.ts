export const DEVELOPMENT_MODEL_CREDENTIAL_ROUTE = "/eve/v1/dev/internal/model-credential";
export const DEVELOPMENT_MODEL_REJECTED_HEADER = "x-eve-model-rejected-token-sha256";
export type DevelopmentModelProvider = "gateway" | "openai" | "anthropic" | "chatgpt";

/** Only transported over the authenticated local control plane; never persisted. */
export interface DevelopmentModelCredential {
  readonly kind: "api-key" | "oauth" | "oidc";
  readonly token: string;
  readonly teamId?: string;
  readonly teamName?: string;
  readonly accountId?: string;
  readonly accountLabel?: string;
}
