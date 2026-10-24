/** Origin of a capability visible in agent inspection. */
type Owner =
  | { readonly kind: "application" }
  | { readonly kind: "framework"; readonly feature: string }
  | {
      readonly kind: "extension";
      readonly mountId?: string;
      readonly namespace: string;
      readonly packageName: string;
    };

type ModuleBacking =
  | {
      readonly kind: "filesystem";
      readonly externalDependencies: readonly string[];
      readonly extensionScope?: { readonly namespace: string; readonly sourceRoot: string };
      readonly mountId?: string;
      readonly sourcePath: string;
    }
  | {
      readonly kind: "programmatic";
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly mountId?: string;
      readonly moduleId: string;
      readonly parameters?: Readonly<Record<string, unknown>>;
      readonly registryId: string;
      readonly revision: string;
      readonly semanticRevision?: string;
    };

type Binding = {
  readonly backing: ModuleBacking;
  readonly logicalPath: string;
  readonly owner: Owner;
};

/** Source of an inspected agent capability. */
export interface AgentInfoSource {
  readonly binding?: Binding;
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly owner: Owner;
  readonly sourceId: string;
  readonly sourceKind: "markdown" | "module" | "skill-package";
}

/** A named, inspected capability. */
export interface AgentInfoEntry extends AgentInfoSource {
  readonly name: string;
}
/** A dynamic capability definition. */
export interface AgentInfoDynamicResolverEntry extends AgentInfoSource {
  readonly slug: string;
}
/** An inspected tool definition. */
export interface AgentInfoToolEntry extends AgentInfoEntry {
  readonly description: string;
  readonly hasAuth: boolean;
  readonly hasExecute: boolean;
  readonly hasModelOutputProjection: boolean;
  readonly hasOutputSchema: boolean;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly requiresApproval: boolean;
}
/** An inspected skill definition. */
export interface AgentInfoSkillEntry extends AgentInfoEntry {
  readonly description: string;
  readonly license?: string;
  readonly markdown: string;
  readonly metadata?: Readonly<Record<string, string>>;
}
/** An inspected static instruction. */
export interface AgentInfoInstructionsEntry extends AgentInfoEntry {
  readonly content: string;
  readonly role: "system" | "user";
}
/** An inspected schedule. */
export interface AgentInfoScheduleEntry extends AgentInfoEntry {
  readonly cron: string;
  readonly hasRun: boolean;
  readonly markdown?: string;
}

type ChannelMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "WEBSOCKET";
/** An inspected channel route. */
export interface AgentInfoChannelEntry extends AgentInfoEntry {
  readonly adapterKind?: string;
  readonly method: ChannelMethod;
  readonly urlPath: string;
}

type SourceDescriptor = {
  readonly backing: ModuleBacking | { readonly kind: "resource"; readonly sourcePath: string };
  readonly form: "derived" | "direct";
  readonly layer: "framework-default" | "extension-package" | "extension-override" | "application";
  readonly logicalPath: string;
  readonly owner: Owner;
  readonly sourceId: string;
};
/** Inspected winning and shadowed channel routes. */
export interface AgentInfoChannels {
  readonly routes: readonly AgentInfoChannelEntry[];
  readonly shadowed: readonly {
    readonly method: ChannelMethod;
    readonly source: SourceDescriptor;
    readonly urlPath: string;
    readonly winnerSourceId: string;
  }[];
}
/** An inspected connection. */
export interface AgentInfoConnectionEntry extends AgentInfoSource {
  readonly connectionName: string;
  readonly description: string;
  readonly hasApproval: boolean;
  readonly hasAuthorization: boolean;
  readonly hasHeaders: boolean;
  readonly protocol: string;
  readonly toolFilter?: unknown;
  readonly url: string;
}
/** An inspected hook. */
export interface AgentInfoHookEntry extends AgentInfoSource {
  readonly eventNames: readonly string[];
  readonly slug: string;
}
/** An inspected memory provider. */
export interface AgentInfoMemoryEntry extends AgentInfoSource {
  readonly description?: string;
  readonly slot: string;
}
/** An inspected sandbox definition. */
export interface AgentInfoSandboxEntry extends AgentInfoSource {
  readonly provider?: string;
  readonly environmentExportName?: string;
  readonly revisionHash: string;
}
/** An inspected local agent. */
export interface AgentInfoSubagentEntry extends AgentInfoEntry {
  readonly configResolver?: AgentInfoDynamicResolverEntry;
  readonly description?: string;
  readonly entryPath: string;
  readonly nodeId: string;
  readonly parentNodeId: string;
  readonly rootPath: string;
  readonly summary: {
    readonly channels: number;
    readonly connections: number;
    readonly hooks: number;
    readonly instructions: number;
    readonly memories: number;
    readonly schedules: number;
    readonly skills: number;
    readonly tools: number;
  };
}
/** An inspected remote agent. */
export interface AgentInfoRemoteAgentEntry extends AgentInfoEntry {
  readonly description: string;
  readonly nodeId: string;
  readonly parentNodeId: string;
  readonly url?: string;
}

/** Static and dynamically resolved tools. */
export interface AgentInfoTools {
  readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
  readonly static: readonly AgentInfoToolEntry[];
}
/** Static and dynamically resolved instructions. */
export interface AgentInfoInstructions {
  readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
  readonly static: readonly AgentInfoInstructionsEntry[];
}

type ModelEndpoint =
  | { readonly kind: "external"; readonly provider: string }
  | {
      readonly kind: "chatgpt";
      readonly state: "checking" | "ready" | "signed-out" | "reauth-required" | "unavailable";
      readonly accountLabel?: string;
    }
  | {
      readonly kind: "gateway";
      readonly connected: true;
      readonly credential: "api-key" | "oidc" | "oauth";
      readonly team?: string;
    }
  | { readonly kind: "gateway"; readonly connected: false };
type AgentModel = {
  readonly contextWindowTokens?: number;
  readonly providerOptions?: unknown;
  readonly reasoning?:
    | "provider-default"
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";
  readonly source?: AgentInfoSource;
} & (
  | {
      readonly endpoint?: ModelEndpoint;
      readonly id: string;
      readonly routing:
        | { readonly kind: "gateway"; readonly target: string; readonly byok?: string }
        | { readonly kind: "external"; readonly provider: string };
    }
  | {
      readonly endpoint?: never;
      readonly id?: never;
      readonly routing: {
        readonly kind: "dynamic";
        readonly resolver: AgentInfoDynamicResolverEntry;
      };
    }
);
type CompositionDiagnostic = {
  readonly kind: "disabled" | "shadowed";
  readonly logicalPath: string;
  readonly owner: Owner;
  readonly sourceId: string;
  readonly winnerSourceId?: string;
};

/** Authoritative `/eve/v1/info` v5 response, independent of its runtime validator. */
export interface AgentInfoResult {
  readonly agent: {
    readonly agentRoot: string;
    readonly appRoot: string;
    readonly config: AgentInfoSource & { readonly binding: Binding };
    readonly description?: string;
    readonly model: AgentModel;
    readonly name: string;
    readonly nodeId: string;
    readonly outputSchema?: unknown;
  };
  readonly capabilities: { readonly devRoutes: boolean };
  readonly channels: AgentInfoChannels;
  readonly composition: {
    readonly disabled: readonly CompositionDiagnostic[];
    readonly shadowed: readonly CompositionDiagnostic[];
  };
  readonly connections: readonly AgentInfoConnectionEntry[];
  readonly diagnostics: { readonly discoveryErrors: number; readonly discoveryWarnings: number };
  readonly hooks: readonly AgentInfoHookEntry[];
  readonly instructions: AgentInfoInstructions;
  readonly instrumentation?: AgentInfoSource;
  readonly kernelEffects: readonly {
    readonly action?: "subagent-call" | "workflow-tool-call" | "unrecognized";
    readonly audience: readonly ("root-session" | "unrecognized")[];
    readonly kind: "dispatch" | "provider-tool" | "unrecognized";
    readonly sourceId: string;
  }[];
  readonly kind: "eve-agent-info";
  readonly memories: readonly AgentInfoMemoryEntry[];
  readonly mode: "development" | "production";
  readonly remoteAgents: {
    readonly entries: readonly AgentInfoRemoteAgentEntry[];
    readonly total: number;
  };
  readonly sandbox: AgentInfoSandboxEntry;
  readonly schedules: readonly AgentInfoScheduleEntry[];
  readonly skills: {
    readonly dynamic: readonly AgentInfoDynamicResolverEntry[];
    readonly static: readonly AgentInfoSkillEntry[];
  };
  readonly subagents: { readonly local: readonly AgentInfoSubagentEntry[]; readonly total: number };
  readonly tools: AgentInfoTools;
  readonly version: 5;
  readonly workspace: { readonly resourceRoot: unknown; readonly rootEntries: readonly string[] };
}
