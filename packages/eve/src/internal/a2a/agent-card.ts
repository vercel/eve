import type { AgentDescription } from "#channel/agent-description.js";
import type { OAuthResourceOptions, UnauthorizedChallenge } from "#channel/auth/definitions.js";
import type { JsonValue } from "#shared/json.js";

import { A2A_PROTOCOL_VERSION, EVE_INTERACTIONS_EXTENSION } from "./protocol.js";

/** An `AgentSkill`: what the card advertises, not an eve skill file. */
export interface A2aAgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples?: readonly string[];
  readonly inputModes?: readonly string[];
  readonly outputModes?: readonly string[];
}

/** Agent Card fields an application can set or override. */
export interface A2aAgentCardOptions {
  readonly name?: string;
  readonly description?: string;
  /** Defaults to the agent's compiled skills, or one skill built from its description. */
  readonly skills?: readonly A2aAgentSkill[];
  readonly provider?: { readonly organization: string; readonly url: string };
  /** The agent's version. Defaults to the installed eve version. */
  readonly version?: string;
  readonly documentationUrl?: string;
  readonly iconUrl?: string;
  /**
   * `securitySchemes` and `securityRequirements` as A2A JSON, replacing the ones read from `auth`:
   * none when it includes `none()`, else an HTTP scheme per challenge its strategies declare
   * (`Basic`, `Bearer`), else `Bearer`.
   */
  readonly securitySchemes?: Readonly<Record<string, JsonValue>>;
  readonly securityRequirements?: readonly JsonValue[];
}

export interface BuildAgentCardInput {
  readonly described: AgentDescription;
  readonly endpointUrl: string;
  readonly eveVersion: string;
  /** Media types the channel accepts as file parts, from its upload policy. */
  readonly fileInputModes: readonly string[];
  readonly security: CardSecurity;
  readonly options: A2aAgentCardOptions | undefined;
}

/** What the route's auth policy tells a client before it has credentials. */
export interface CardSecurity {
  readonly anonymous: boolean;
  readonly challenges: readonly UnauthorizedChallenge[];
  readonly oauth: OAuthResourceOptions | undefined;
}

const OUTPUT_MODES = ["text/markdown", "text/plain", "application/json"];

export function buildAgentCard(input: BuildAgentCardInput): Record<string, JsonValue> {
  const { described, options } = input;
  const description =
    options?.description ?? described.description ?? `The ${described.name} eve agent.`;
  const skills =
    options?.skills ??
    (described.skills.length > 0
      ? described.skills.map((skill) => ({
          description: skill.description,
          id: skill.name,
          name: skill.name,
          tags: [] as string[],
        }))
      : [{ description, id: "default", name: described.name, tags: [] as string[] }]);
  const card = {
    capabilities: {
      extendedAgentCard: false,
      extensions: [
        {
          description:
            "Structured eve interactions (questions, approvals, sign-ins) on interrupted " +
            "status messages, answered with a data part.",
          required: false,
          uri: EVE_INTERACTIONS_EXTENSION,
        },
      ],
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ["text/plain", "application/json", ...input.fileInputModes],
    defaultOutputModes: OUTPUT_MODES,
    description,
    name: options?.name ?? described.name,
    skills,
    supportedInterfaces: [
      {
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        url: input.endpointUrl,
      },
    ],
    version: options?.version ?? input.eveVersion,
    // Undefined fields drop out when the card serializes.
    documentationUrl: options?.documentationUrl,
    iconUrl: options?.iconUrl,
    provider: options?.provider,
    ...securityFields(input),
  };
  return JSON.parse(JSON.stringify(card)) as Record<string, JsonValue>;
}

/**
 * `securitySchemes` and `securityRequirements` from the auth policy: none for a policy that admits
 * anonymous callers, else one HTTP scheme per challenge its 401 sends (Bearer when it declares
 * none, as `routeAuth` does), any one of which satisfies the route.
 */
function securityFields(input: BuildAgentCardInput): Record<string, JsonValue> {
  const { options, security } = input;
  if (options?.securitySchemes !== undefined) {
    return {
      securitySchemes: options.securitySchemes,
      ...(options.securityRequirements !== undefined && {
        securityRequirements: options.securityRequirements,
      }),
    };
  }
  if (security.anonymous) return {};
  const schemes = new Set(security.challenges.map((challenge) => challenge.scheme));
  if (schemes.size === 0) schemes.add("Bearer");
  const issuer = security.oauth?.issuer ?? security.oauth?.authorizationServers?.[0];
  const securitySchemes: Record<string, JsonValue> = {};
  const securityRequirements: JsonValue[] = [];
  for (const scheme of schemes) {
    const name = scheme.toLowerCase();
    const http: Record<string, JsonValue> = { scheme };
    if (scheme === "Bearer" && issuer !== undefined) {
      http.description = `An OAuth 2.0 access token from ${issuer}.`;
    }
    securitySchemes[name] = { httpAuthSecurityScheme: http };
    const scopes = scheme === "Bearer" ? [...(security.oauth?.scopes ?? [])] : [];
    securityRequirements.push({ schemes: { [name]: { list: scopes } } });
  }
  return { securityRequirements, securitySchemes };
}
