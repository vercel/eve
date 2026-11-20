import type {
  RuntimeSessionAuthAttributes,
  RuntimeSessionAuthContext,
  RuntimeSessionAuthenticator,
  RuntimeSessionPrincipalType,
} from "#shared/session-auth.js";

export type RouteAuthAttributes = RuntimeSessionAuthAttributes;

export interface AuthenticatedCallerPrincipal {
  readonly attributes: RouteAuthAttributes;
  readonly authenticator: RuntimeSessionAuthenticator;
  readonly claims: RouteAuthAttributes;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: RuntimeSessionPrincipalType;
  readonly subject?: string;
}

export interface ResolvedTokenClaimMatchers {
  readonly claims?: Readonly<Record<string, readonly string[]>>;
  readonly subjects?: readonly string[];
}

export interface CurrentVercelProject {
  readonly environment?: string;
  readonly projectId: string;
}

export interface ResolvedHttpBasicAuthStrategy {
  readonly kind: "http-basic";
  readonly password: string;
  readonly username: string;
}

export interface ResolvedJwtHmacAuthStrategy extends ResolvedTokenClaimMatchers {
  readonly algorithm: "HS256" | "HS384" | "HS512";
  readonly audiences: readonly string[];
  readonly clockSkewSeconds: number;
  readonly issuer: string;
  readonly kind: "jwt-hmac";
  readonly secret: string;
}

export interface ResolvedJwtEcdsaAuthStrategy extends ResolvedTokenClaimMatchers {
  readonly algorithm: "ES256" | "ES384" | "ES512";
  readonly audiences: readonly string[];
  readonly clockSkewSeconds: number;
  readonly issuer: string;
  readonly kind: "jwt-ecdsa";
  readonly publicKey: string;
}

export interface ResolvedOidcAuthStrategy extends ResolvedTokenClaimMatchers {
  readonly acceptCurrentVercelProject: boolean;
  readonly audiences: readonly string[];
  readonly clockSkewSeconds: number;
  readonly currentVercelProject?: CurrentVercelProject;
  readonly discoveryUrl: string;
  readonly issuer: string;
  readonly kind: "oidc";
}

export type RouteStrategyAuthenticationResult =
  | {
      readonly kind: "authenticated";
      readonly principal: AuthenticatedCallerPrincipal;
    }
  | {
      readonly kind: "caller-not-allowed";
    }
  | {
      readonly kind: "misconfigured";
      readonly message: string;
    }
  | {
      readonly kind: "not-authenticated";
    };

export function createRuntimeSessionAuthContext(
  principal: AuthenticatedCallerPrincipal,
): RuntimeSessionAuthContext {
  return {
    attributes: principal.attributes,
    authenticator: principal.authenticator,
    issuer: principal.issuer,
    principalId: principal.principalId,
    principalType: principal.principalType,
    subject: principal.subject,
  };
}
