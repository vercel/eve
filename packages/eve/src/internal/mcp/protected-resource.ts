export interface McpProtectedResourceMetadataOptions {
  readonly authorizationServers: readonly string[];
  readonly resource: string;
  readonly scopesSupported?: readonly string[];
}

/** Creates RFC 9728 protected-resource metadata for an MCP endpoint. */
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

/** Creates the MCP OAuth bearer challenge used to discover resource metadata. */
export function createMcpAuthChallenge(resourceMetadataUrl: string): Response {
  return Response.json(
    { error: "unauthorized", error_description: "A bearer access token is required." },
    {
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${escapeChallenge(resourceMetadataUrl)}"`,
      },
      status: 401,
    },
  );
}

function escapeChallenge(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
