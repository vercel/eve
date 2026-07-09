import {
  type AuthMode,
  type ConnectionSurface,
  type ConnectionProtocol,
  type ConnectionSpec,
  type Integration,
  authModeLabel,
  protocolLabel,
} from "./data";
import type { ConnectionCredential, ConnectionCredentialUse } from "@vercel/eve-catalog";

/**
 * One entry per (protocol, auth mode) the connection supports. The detail
 * page renders these as a pair of switchers; `key` is `"<protocol>:<auth>"`.
 */
export interface ConnectionSetup {
  surfaces: Array<{
    protocol: ConnectionProtocol;
    label: string;
    authModes: AuthMode[];
  }>;
  /** Generated quick-start markdown keyed by `"<protocol>:<auth>"`. */
  variants: Record<string, string>;
}

export const setupKey = (protocol: ConnectionProtocol, auth: AuthMode): string =>
  `${protocol}:${auth}`;

const connectorOf = (
  slug: string,
  spec: ConnectionSpec,
  surface: ConnectionSurface,
  auth: AuthMode,
): string => {
  const { credential } = credentialSelectionForAuth(spec, surface, auth);
  return credential?.connector ?? spec.connector ?? slug;
};

const credentialSelectionForAuth = (
  spec: ConnectionSpec,
  surface: ConnectionSurface,
  auth: AuthMode,
): { credential?: ConnectionCredential; credentialUse?: ConnectionCredentialUse } => {
  const surfaceRecord = surface.protocol === "mcp" ? spec.mcp : spec.openapi;
  if (surfaceRecord?.auth.status !== "required") {
    return {};
  }
  const entry = surfaceRecord.auth.entries.find((candidate) => candidate.id === auth);
  const credentialUse = entry?.use[0];
  if (!credentialUse) {
    return {};
  }
  const credential = spec.credentials?.[credentialUse.id];
  return credential ? { credential, credentialUse } : { credentialUse };
};

const usesConnectCredential = (
  credential: ConnectionCredential | undefined,
  credentialUse: ConnectionCredentialUse | undefined,
): boolean =>
  credentialUse?.mechanics.source === "connect" || Boolean(credential?.type.startsWith("connect_"));

const envVarsForCredential = (credential: ConnectionCredential | undefined): string[] =>
  Object.keys(credential?.fields ?? {});

const httpCredentialHeader = (
  credential: ConnectionCredential | undefined,
  credentialUse: ConnectionCredentialUse | undefined,
): string | null => {
  if (credentialUse?.mechanics.source !== "http" || credentialUse.mechanics.in !== "header") {
    return null;
  }

  const headerName = credentialUse.mechanics.headerName ?? "Authorization";
  const envVars = envVarsForCredential(credential);
  const envVar = envVars[0];
  const scheme = credentialUse.mechanics.scheme;
  if (scheme && scheme !== "Basic" && envVar) {
    return `    "${headerName}": \`${scheme} \${process.env.${envVar}}\`,`;
  }

  if (scheme === "Basic") {
    const [userEnv, tokenEnv] = envVars;
    if (userEnv && tokenEnv) {
      return `    "${headerName}": \`Basic \${Buffer.from(\`\${process.env.${userEnv}}:\${process.env.${tokenEnv}}\`).toString("base64")}\`,`;
    }
    if (envVar) {
      return `    "${headerName}": \`Basic \${process.env.${envVar}}\`,`;
    }
  }

  if (envVar) {
    return `    "${headerName}": process.env.${envVar}!,`;
  }

  return null;
};

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
  const surface = spec.surfaces.find((candidate) => candidate.protocol === protocol);
  if (!surface) {
    return "";
  }
  const connector = connectorOf(integration.slug, spec, surface, auth);
  const { credential, credentialUse } = credentialSelectionForAuth(spec, surface, auth);
  const hasConnectAuth = usesConnectCredential(credential, credentialUse);
  const description = spec.description ?? integration.tagline;
  const defineFn = protocol === "mcp" ? "defineMcpClientConnection" : "defineOpenAPIConnection";
  const transport = protocol === "mcp" ? spec.mcp : spec.openapi;

  const imports = [`import { ${defineFn} } from "eve/connections";`];
  if (hasConnectAuth) {
    imports.unshift(`import { connect } from "@vercel/connect/eve";`);
  }

  const fields: string[] = [];
  if (protocol === "mcp" && spec.mcp) {
    fields.push(`  url: "${spec.mcp.url}",`);
  } else if (protocol === "openapi" && spec.openapi) {
    fields.push(`  spec: "${spec.openapi.spec}",`);
    if (spec.openapi.baseUrl) {
      fields.push(`  baseUrl: "${spec.openapi.baseUrl}",`);
    }
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
  const credentialHeader = hasConnectAuth ? null : httpCredentialHeader(credential, credentialUse);
  if (credentialHeader) {
    headerLines.push(credentialHeader);
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
  if (auth === "jwtBearer") {
    return "Connect exchanges a JWT bearer assertion for a provider token. `principalToSubject` maps each principal to the subject your IdP expects.";
  }
  if (auth === "basic") {
    return "Store the provider credentials in environment variables. eve sends them as an HTTP Basic authorization header when it calls this surface.";
  }
  return "Store the provider token in an environment variable. eve sends it as an Authorization bearer header when it calls this surface.";
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
  const surface = spec.surfaces.find((candidate) => candidate.protocol === protocol);
  if (!surface) {
    return "";
  }
  return [
    `Create \`agent/connections/${integration.slug}.ts\` for the ${protocolLabel[protocol]} surface. The connection name is derived from the filename:`,
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
  const surfaces =
    spec?.surfaces
      .filter((surface) => surface.authModes.length > 0)
      .map((surface) => ({
        protocol: surface.protocol,
        label: protocolLabel[surface.protocol],
        authModes: surface.authModes,
      })) ?? [];
  const variants: Record<string, string> = {};
  for (const surface of surfaces) {
    for (const auth of surface.authModes) {
      variants[setupKey(surface.protocol, auth)] = buildVariant(
        integration,
        surface.protocol,
        auth,
      );
    }
  }
  return { surfaces, variants };
};

const specUsesConnect = (spec: ConnectionSpec): boolean =>
  Object.values(spec.credentials ?? {}).some((credential) =>
    credential.type.startsWith("connect_"),
  );

const envVarsForSpec = (spec: ConnectionSpec): string[] => [
  ...new Set(
    Object.values(spec.credentials ?? {}).flatMap((credential) => envVarsForCredential(credential)),
  ),
];

/** Generated Install markdown for a connection. */
export const buildConnectionInstall = (integration: Integration): string => {
  const spec = integration.connection;
  if (!spec) {
    return "";
  }
  if (!specUsesConnect(spec)) {
    return [
      "Connections live under `agent/connections/`. Install the framework, then provide the provider credentials through environment variables:",
      ``,
      "```bash",
      "npm install eve@latest",
      "```",
    ].join("\n");
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
  const services = new Set<string>();
  for (const credential of Object.values(spec.credentials ?? {})) {
    if (credential.service) services.add(credential.service);
  }
  const envVars = envVarsForSpec(spec);

  const sections: string[] = [];

  if (services.size > 0) {
    sections.push(
      [
        "Create the connector from the project or agent folder that will consume it, then link the project and pull OIDC locally:",
        ``,
        "```bash",
        ...[...services].map((service) => `vercel connect create ${service}`),
        "vercel link",
        "vercel env pull",
        "```",
      ].join("\n"),
    );
  }

  if (envVars.length > 0) {
    sections.push(
      [
        "Add the provider credentials as environment variables before running the agent:",
        ``,
        "```bash",
        ...envVars.map((envVar) => `vercel env add ${envVar}`),
        "vercel env pull",
        "```",
        ``,
        "For local-only testing, put the same names in `.env.local`.",
      ].join("\n"),
    );
  }

  if (sections.length === 0) {
    sections.push(
      [
        "Create the connector from the project or agent folder that will consume it, then link the project and pull OIDC locally:",
        ``,
        "```bash",
        `vercel connect create <service-or-mcp-url>`,
        "vercel link",
        "vercel env pull",
        "```",
      ].join("\n"),
    );
  }

  if (spec.authModes.includes("jwtBearer")) {
    sections.push(
      'For JWT bearer, `principalToSubject` controls the asserted subject. The default maps app principals to `{ type: "app" }` and user principals to `{ type: "user", id, issuer }`.',
    );
  }

  if (spec.configureNote) {
    sections.push(spec.configureNote);
  }

  sections.push(
    "See the [Connections docs](/docs/connections) for principal types, headers, approval, and protocol-specific filters.",
  );
  return sections.join("\n\n");
};

/** Human label for an auth-mode switcher button. */
export const authModeButtonLabel = (auth: AuthMode): string => authModeLabel[auth];
