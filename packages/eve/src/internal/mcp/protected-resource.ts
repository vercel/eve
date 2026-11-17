import { escapeAuthChallengeParameter } from "#channel/auth/definitions.js";

interface McpProtectedResourceMetadataOptions {
  readonly authorizationServers: readonly string[];
  readonly resource: string;
  readonly scopesSupported?: readonly string[];
}

export function createMcpProtectedResourceMetadata(
  options: McpProtectedResourceMetadataOptions,
): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {
    authorization_servers: options.authorizationServers,
    resource: options.resource,
  };
  if (options.scopesSupported !== undefined) {
    metadata.scopes_supported = options.scopesSupported;
  }
  return metadata;
}

export function createMcpResourceChallenge(
  resourceMetadataUrl: string,
  scopes?: readonly string[],
): string {
  const parameters = [`resource_metadata="${escapeAuthChallengeParameter(resourceMetadataUrl)}"`];
  if (scopes?.length) {
    parameters.push(`scope="${escapeAuthChallengeParameter(scopes.join(" "))}"`);
  }
  return `Bearer ${parameters.join(", ")}`;
}
