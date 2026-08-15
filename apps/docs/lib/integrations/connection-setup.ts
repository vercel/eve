import {
  type AuthMode,
  type ConnectionProtocol,
  type ConnectionSpec,
  type Integration,
  authModeLabel,
  protocolLabel,
} from "./data";

/**
 * One entry per (protocol, auth mode) the connection supports. The detail
 * page renders these as a pair of switchers; `key` is `"<protocol>:<auth>"`.
 */
export interface ConnectionSetup {
  protocols: ConnectionProtocol[];
  authModes: AuthMode[];
  /** Generated quick-start markdown keyed by `"<protocol>:<auth>"`. */
  variants: Record<string, string>;
  /** Generated configure markdown keyed by `"<protocol>:<auth>"`. */
  configureVariants: Record<string, string>;
}

export const setupKey = (protocol: ConnectionProtocol, auth: AuthMode): string =>
  `${protocol}:${auth}`;

const connectorOf = (slug: string, spec: ConnectionSpec, auth?: AuthMode): string =>
  (auth === undefined ? undefined : spec.connectors?.[auth]) ?? spec.connector ?? slug;

/** The TypeScript connection file for one (protocol, auth) combination. */
const buildSnippet = (
  integration: Integration,
  protocol: ConnectionProtocol,
  auth: AuthMode,
): string => {
  const spec = integration.connection;
  if (!spec) {
    return "";
  }
  const connector = connectorOf(integration.slug, spec, auth);
  const description = spec.description ?? integration.tagline;
  const defineFn = protocol === "mcp" ? "defineMcpClientConnection" : "defineOpenAPIConnection";
  const transport = protocol === "mcp" ? spec.mcp : spec.openapi;

  const imports = [
    ...(auth === "apiKey" ? [] : [`import { connect } from "@vercel/connect/eve";`]),
    `import { ${defineFn} } from "eve/connections";`,
  ];

  const fields: string[] = [];
  if (protocol === "mcp" && spec.mcp) {
    fields.push(`  url: "${spec.mcp.url}",`);
  } else if (protocol === "openapi" && spec.openapi) {
    fields.push(`  spec: "${spec.openapi.spec}",`);
    fields.push(`  baseUrl: "${spec.openapi.baseUrl}",`);
  }
  fields.push(`  description: "${description}",`);

  if (auth === "user") {
    fields.push(`  auth: connect("${connector}"),`);
  } else if (auth === "app") {
    fields.push(`  auth: connect({ connector: "${connector}", principalType: "app" }),`);
  } else if (auth === "jwtBearer") {
    fields.push(
      `  auth: connect({`,
      `    connector: "${connector}",`,
      `    principalToSubject: (principal) => {`,
      `      const email = principal.type === "user" ? principal.attributes?.email : undefined;`,
      `      if (typeof email !== "string") {`,
      `        throw new Error("JWT bearer authentication requires a user principal with an email.");`,
      `      }`,
      `      return { type: "jwt-bearer", sub: email };`,
      `    },`,
      `  }),`,
    );
  }

  const headerLines: string[] = [];
  if (auth === "apiKey" && spec.apiKey) {
    headerLines.push(`    "${spec.apiKey.header}": process.env.${spec.apiKey.env}!,`);
  }
  for (const [name, value] of Object.entries(transport?.headers ?? {})) {
    headerLines.push(`    "${name}": "${value}",`);
  }
  if (headerLines.length > 0) {
    fields.push(`  headers: () => ({`, ...headerLines, `  }),`);
  }

  return [
    `// agent/connections/${integration.slug}.ts`,
    ...imports,
    ``,
    `export default ${defineFn}({`,
    ...fields,
    `});`,
  ].join("\n");
};

const authNote = (auth: AuthMode): string => {
  if (auth === "user") {
    return "Connect owns the OAuth flow, and each end-user authorizes in their own browser before their first tool call.";
  }
  if (auth === "app") {
    return "Connect authenticates as the agent itself through one shared installation, with no per-user consent.";
  }
  if (auth === "apiKey") {
    return "Keep the API key in a server-side environment variable. eve sends it directly to the MCP server and does not expose it to the model.";
  }
  return "Connect exchanges a JWT bearer assertion for a provider token. `principalToSubject` maps each principal to the subject your IdP expects.";
};

/** Quick-start markdown for one (protocol, auth) combination. */
const buildVariant = (
  integration: Integration,
  protocol: ConnectionProtocol,
  auth: AuthMode,
): string => {
  const spec = integration.connection;
  if (!spec) {
    return "";
  }
  return [
    `Create \`agent/connections/${integration.slug}.ts\`. The connection name is derived from the filename:`,
    ``,
    "```ts",
    buildSnippet(integration, protocol, auth),
    "```",
    ``,
    authNote(auth),
  ].join("\n");
};

/** Configure markdown for one auth mode. */
const buildConfigureVariant = (integration: Integration, auth: AuthMode): string => {
  const spec = integration.connection;
  if (!spec) {
    return "";
  }
  const sections: string[] = [];

  if (auth !== "apiKey") {
    const connector = connectorOf(integration.slug, spec, auth);
    const modeService = spec.connectorServices?.[auth];
    const connectorService = modeService ?? spec.connectorService ?? connector;
    const namedConnector = modeService !== undefined || spec.connectorService !== undefined;
    sections.push(
      [
        "Link your project, create the connector, and pull OIDC locally:",
        ``,
        "```bash",
        "vercel link",
        `vercel connect create ${connectorService}${
          namedConnector ? ` --name ${integration.slug}` : ""
        }`,
        "vercel env pull",
        "```",
      ].join("\n"),
    );
  }

  if (auth === "apiKey" && spec.apiKey) {
    sections.push(
      [
        `Set \`${spec.apiKey.env}\` as a server-side environment variable:`,
        ``,
        "```bash",
        `${spec.apiKey.env}=your_api_key`,
        "```",
      ].join("\n"),
    );
  }

  if (auth === "jwtBearer") {
    sections.push(
      'For JWT bearer, `principalToSubject` controls the asserted subject. The default maps app principals to `{ type: "app" }` and user principals to `{ type: "user", id, issuer }`.',
    );
  }

  const modeNote = spec.configureNotes?.[auth];
  if (modeNote) {
    sections.push(modeNote);
  }
  if (spec.configureNote) {
    sections.push(spec.configureNote);
  }

  sections.push(
    "See the [Connections docs](/docs/connections) for principal types, headers, approval, and protocol-specific filters.",
  );
  return sections.join("\n\n");
};

/** All quick-start and configure variants for a connection, plus their switcher options. */
export const buildConnectionSetup = (integration: Integration): ConnectionSetup => {
  const spec = integration.connection;
  const protocols = spec ? (integration.protocols ?? []) : [];
  const authModes = spec?.authModes ?? [];
  const variants: Record<string, string> = {};
  const configureVariants: Record<string, string> = {};
  for (const protocol of protocols) {
    for (const auth of authModes) {
      const key = setupKey(protocol, auth);
      variants[key] = buildVariant(integration, protocol, auth);
      configureVariants[key] = buildConfigureVariant(integration, auth);
    }
  }
  return { protocols, authModes, variants, configureVariants };
};

/** Generated Install markdown for a connection. */
export const buildConnectionInstall = (integration: Integration): string => {
  if (!integration.connection) {
    return "";
  }
  return [
    "Add the connection from eve's registry. This writes the initial definition under `agent/connections/` and installs its authentication dependency when needed:",
    ``,
    "```bash",
    `eve add connection/${integration.slug}`,
    "```",
  ].join("\n");
};

/** Generated Configure markdown for a connection. */
export const buildConnectionConfigure = (integration: Integration): string => {
  const setup = buildConnectionSetup(integration);
  return setup.protocols
    .flatMap((protocol) =>
      setup.authModes.map((auth) => {
        const content = setup.configureVariants[setupKey(protocol, auth)] ?? "";
        return `### ${protocolLabel[protocol]} · ${authModeLabel[auth]}\n\n${content}`;
      }),
    )
    .join("\n\n");
};

/** Human label for an auth-mode switcher button. */
export const authModeButtonLabel = (auth: AuthMode): string => authModeLabel[auth];
