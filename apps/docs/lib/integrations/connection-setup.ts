import {
  type AuthMode,
  type ConnectionProtocol,
  type ConnectionSpec,
  type Integration,
  authModeLabel,
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
}

export const setupKey = (protocol: ConnectionProtocol, auth: AuthMode): string =>
  `${protocol}:${auth}`;

const connectorOf = (slug: string, spec: ConnectionSpec): string => spec.connector ?? slug;

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
  const connector = connectorOf(integration.slug, spec);
  const description = spec.description ?? integration.tagline;
  const defineFn = protocol === "mcp" ? "defineMcpClientConnection" : "defineOpenAPIConnection";
  const transport = protocol === "mcp" ? spec.mcp : spec.openapi;

  const imports = [
    `import { connect } from "@vercel/connect/eve";`,
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
      `    principalToSubject: (principal) => ({`,
      `      type: "jwt-bearer",`,
      `      sub: principal.attributes.email,`,
      `    }),`,
      `  }),`,
    );
  }

  const headerLines: string[] = [];
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

/** All quick-start variants for a connection, plus its switcher options. */
export const buildConnectionSetup = (integration: Integration): ConnectionSetup => {
  const spec = integration.connection;
  const protocols = spec ? (integration.protocols ?? []) : [];
  const authModes = spec?.authModes ?? [];
  const variants: Record<string, string> = {};
  for (const protocol of protocols) {
    for (const auth of authModes) {
      variants[setupKey(protocol, auth)] = buildVariant(integration, protocol, auth);
    }
  }
  return { protocols, authModes, variants };
};

/** Generated Install markdown for a connection. */
export const buildConnectionInstall = (integration: Integration): string => {
  const spec = integration.connection;
  if (!spec) {
    return "";
  }
  return [
    "Connections live under `agent/connections/`. Auth is brokered by [Vercel Connect](https://vercel.com/docs/connect), so install the framework and the Connect SDK:",
    ``,
    "```bash",
    "npm install eve@latest @vercel/connect",
    "```",
  ].join("\n");
};

/** Generated Configure markdown for a connection. */
export const buildConnectionConfigure = (integration: Integration): string => {
  const spec = integration.connection;
  if (!spec) {
    return "";
  }
  const connector = connectorOf(integration.slug, spec);
  const sections: string[] = [
    [
      "Create the connector, link it to your project, and pull OIDC locally:",
      ``,
      "```bash",
      `vercel connect create ${connector}`,
      "vercel link",
      "vercel env pull",
      "```",
    ].join("\n"),
  ];

  if (spec.authModes.includes("jwtBearer")) {
    sections.push(
      'For JWT bearer, `principalToSubject` controls the asserted subject. The default maps app principals to `{ type: "app" }` and user principals to `{ type: "user", id, issuer }`.',
    );
  }

  if (spec.configureNote) {
    sections.push(spec.configureNote);
  }

  sections.push(
    "See the [Connections docs](/docs/connections) for principal types, headers, approval, and tool filters.",
  );
  return sections.join("\n\n");
};

/** Human label for an auth-mode switcher button. */
export const authModeButtonLabel = (auth: AuthMode): string => authModeLabel[auth];
