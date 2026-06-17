import type {
  NonInteractiveAuthorizationDefinition,
  TokenResult,
} from "#runtime/connections/types.js";

/**
 * Non-interactive authorization strategy for one brokered sandbox
 * credential. Interactive authorization is rejected because sandbox
 * attachment cannot pause a step for consent.
 */
export type SandboxCredentialAuth = Omit<NonInteractiveAuthorizationDefinition, "principalType"> & {
  readonly principalType?: NonInteractiveAuthorizationDefinition["principalType"];
};

/**
 * Author-chosen credential labels mapped to authorization strategies.
 */
export type SandboxCredentialMap = Readonly<Record<string, SandboxCredentialAuth>>;

/**
 * Credentials resolved for one step and handed to a network-policy builder.
 */
export type ResolvedSandboxCredentials<C extends SandboxCredentialMap> = {
  readonly [K in keyof C]: TokenResult;
};
