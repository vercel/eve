import type { ConnectionEvents } from "#public/definitions/connections/events.js";
import type { ConnectionEventsBackend } from "#shared/connection-events.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import type { CompiledChannel } from "#channel/compiled-channel.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { HeadersValue } from "#client/types.js";
import type { DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";
import type { ChannelRouteMethod, RouteContext } from "#public/definitions/channel.js";
import type { RouteHandler, WebSocketRouteHandler } from "#channel/routes.js";
import type { OutboundAuthFn } from "#public/agents/auth.js";
import type { StreamEventHook } from "#public/definitions/hook.js";
import type { ApprovalPolicy, Approval } from "#approval/definition.js";
import type { ToolModelOutput, ToolModelOutputContext } from "#tools/definition.js";
import type { WorkflowProgramOptions } from "#tools/workflow-program-input.js";
import type { ConnectionToolCallDefinition } from "#public/definitions/connections/tool-call.js";
import type {
  AuthorizationDefinition,
  ConnectionAuthResolver,
  ConnectionProtocol,
  HeadersDefinition,
  ToolFilterDefinition,
} from "#shared/connection-types.js";
import type { OpenAPISpecSource } from "#public/definitions/connections/openapi.js";
import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";
import type { JsonValue } from "#shared/json.js";
import type { Optional } from "#shared/optional.js";
import type { Node } from "#shared/node.js";
import type {
  SourceRef,
  ModuleSourceRef,
  SkillPackageSourceRef,
  MarkdownSourceRef,
} from "#shared/source-ref.js";
import type { NamedSkillDefinition } from "#shared/skill-definition.js";
import type {
  AgentLimitsDefinition,
  InternalAgentDefinition,
  AgentToolExposure,
} from "#shared/agent-definition.js";
import type { RuntimeDynamicModelReference } from "#runtime/agent/bootstrap.js";
import type { InternalToolDefinitionWithExecuteFn } from "#tools/definition.js";
import type { CompiledToolBehavior } from "#tools/behavior.js";
import type { SandboxEnvironmentIdentity, SandboxSelector } from "#shared/sandbox-environment.js";
import type { ToolSchema } from "#tools/schema.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";
import type { DynamicSchedulesDefinition } from "#public/schedules/subscription.js";
import type { MemoryDefinition } from "#public/memory/index.js";

export type ResolvedModuleSourceRef = Readonly<ModuleSourceRef>;

export type ResolvedInstructionsDefinition = Readonly<
  SourceRef & {
    content: string;
    name: string;
    owner: AgentSourceOwner;
    role: "system" | "user";
  } & (Omit<MarkdownSourceRef<undefined>, "definition"> | ModuleSourceRef)
>;

export type ResolvedSkillDefinition = Readonly<
  NamedSkillDefinition &
    (Omit<MarkdownSourceRef<undefined>, "definition"> | ModuleSourceRef | SkillPackageSourceRef) & {
      metadata?: Readonly<Record<string, string>>;
      owner?: AgentSourceOwner;
    }
>;

export type ResolvedScheduleDefinition = Readonly<
  SourceRef & {
    readonly cron: string;
    readonly timezone?: string;
    readonly name: string;
    readonly markdown?: string;
    readonly hasRun: boolean;
    readonly sourceKind: "markdown" | "module";
  } & (Omit<MarkdownSourceRef<undefined>, "definition"> | ModuleSourceRef)
>;

export interface ResolvedConnectionEvents {
  readonly callbacks: ConnectionEvents;
  readonly authorization: Readonly<AuthorizationDefinition>;
  readonly connector: string;
  readonly backend: ConnectionEventsBackend;
}

export interface ResolvedConnectionDefinition extends ResolvedModuleSourceRef {
  readonly experimental_events?: ResolvedConnectionEvents;
  readonly protocolVersionDiscovery?: boolean;
  readonly forwardPrincipal?: boolean;
  readonly approval?: Approval;
  readonly authorization?: Readonly<AuthorizationDefinition> | ConnectionAuthResolver;
  readonly connectionName: string;
  readonly description: string;
  readonly headers?: Readonly<HeadersDefinition>;
  readonly instanceId?: string;
  readonly toolCall?: Readonly<ConnectionToolCallDefinition>;
  readonly protocol: ConnectionProtocol;
  readonly spec?: OpenAPISpecSource;
  readonly tools?: Readonly<ToolFilterDefinition>;
  readonly url: string;
}

type ResolvedSandboxDefinitionBase = ResolvedModuleSourceRef & {
  readonly revisionHash: string;
  readonly selector: SandboxSelector;
};

export type ResolvedSandboxDefinition = ResolvedSandboxDefinitionBase &
  (
    | { readonly environment: SandboxEnvironmentIdentity; readonly kind: "independent" }
    | { readonly kind: "parent" }
  );

export type ResolvedToolDefinition = Readonly<
  Omit<
    Optional<InternalToolDefinitionWithExecuteFn<unknown, unknown>, "execute">,
    "inputSchema" | "outputSchema"
  >
> &
  ResolvedModuleSourceRef & {
    readonly behavior?: CompiledToolBehavior;
    readonly owner: AgentSourceOwner;
    readonly inputSchema: ToolSchema | null;
    readonly executeInput?: (input: unknown) => JsonValue;
    readonly label?: import("#tools/definition.js").InternalToolLabelDefinition | false;
    readonly outputSchema?: ToolSchema;
    readonly approval?: Approval;
    readonly toModelOutput?: (
      output: unknown,
      ctx: ToolModelOutputContext,
    ) => ToolModelOutput | Promise<ToolModelOutput>;
    readonly workflowProgram?: WorkflowProgramOptions;
  };

export interface ResolvedHookDefinition extends ResolvedModuleSourceRef {
  readonly slug: string;
  readonly events: Readonly<Record<string, StreamEventHook<SessionEvent>>>;
}

export type DynamicEvaluateFn = (ctx: never) => unknown;

export interface ResolvedDynamicSource extends Readonly<ModuleSourceRef> {
  readonly evaluate: DynamicEvaluateFn;
}

export interface ResolvedChannelDefinition extends ResolvedModuleSourceRef {
  readonly name: string;
  readonly method: ChannelRouteMethod;
  readonly adapter?: ChannelAdapter;
  readonly turnPolicy?: CompiledChannel["turnPolicy"];
  readonly cors?: NormalizedChannelCorsOptions;
  readonly urlPath: string;
  readonly fetch: (req: Request, ctx: RouteContext) => Promise<Response>;
  readonly receive?: CompiledChannel["receive"];
  readonly definition?: CompiledChannel;
  readonly handler?: RouteHandler;
  readonly websocket?: WebSocketRouteHandler;
}

export type ResolvedRuntimeSubagentNode = Readonly<
  ModuleSourceRef &
    Node & {
      kind: "subagent";
      name: string;
      tool?: AgentToolExposure;
    } & (
      | {
          description: string;
          dynamic?: never;
        }
      | {
          description?: never;
          dynamic: ResolvedDynamicSubagentDefinition;
        }
    )
>;

export type ResolvedRuntimeRemoteAgentNode = Readonly<
  ModuleSourceRef &
    Node & {
      auth?: OutboundAuthFn;
      description: string;
      forwardPrincipal?: boolean;
      headers?: HeadersValue;
      kind: "remote";
      name: string;
      path: string;
      tool?: AgentToolExposure;
      url: string;
    }
>;

export type ResolvedRuntimeDelegationNode =
  | ResolvedRuntimeRemoteAgentNode
  | ResolvedRuntimeSubagentNode;

export type ResolvedDynamicSubagentDefinition = ResolvedDynamicSource;

type ResolvedAgentDefinitionBase = Omit<
  InternalAgentDefinition,
  "approval" | "build" | "limits" | "model" | "source"
> & {
  approval?: ApprovalPolicy;
  limits?: AgentLimitsDefinition;
  source?: Readonly<NonNullable<InternalAgentDefinition["source"]>>;
};

export type ResolvedAgentDefinition = Readonly<
  ResolvedAgentDefinitionBase &
    (
      | {
          dynamicModel?: never;
          model: InternalAgentDefinition["model"];
        }
      | {
          dynamicModel: RuntimeDynamicModelReference;
          model?: never;
        }
    )
>;

interface ResolvedAgentMetadata {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly diagnosticsSummary: DiscoverDiagnosticsSummary;
}

export type ResolvedMemoryDefinition = Readonly<
  MemoryDefinition &
    ModuleSourceRef & {
      readonly slot: string;
      readonly offersTools?: true;
    }
>;

export interface ResolvedScheduleCollection extends Readonly<ModuleSourceRef> {
  readonly name: string;
  readonly definition: DynamicSchedulesDefinition<unknown>;
  readonly namedScope?: {
    readonly definition: string;
    readonly name: string;
    readonly description?: string;
  };
  readonly offersTools?: true;
}

export type DynamicDefinitionKind = "connection" | "instructions" | "skill" | "tool";

export interface ResolvedDynamicDefinition<
  K extends DynamicDefinitionKind = DynamicDefinitionKind,
> extends ResolvedDynamicSource {
  readonly kind: K;
  readonly slug: string;
  readonly extensionNamespace?: string;
}

export type ResolvedDefinition =
  | { [K in DynamicDefinitionKind]: ResolvedDynamicDefinition<K> }[DynamicDefinitionKind]
  | (ResolvedHookDefinition & { readonly kind: "hook" })
  | (ResolvedMemoryDefinition & { readonly kind: "memory" })
  | (ResolvedScheduleCollection & { readonly kind: "schedules" });

export function declared<K extends ResolvedDefinition["kind"]>(
  agent: Pick<ResolvedAgent, "definitions">,
  kind: K,
): readonly Extract<ResolvedDefinition, { readonly kind: K }>[] {
  return agent.definitions.filter(
    (definition): definition is Extract<ResolvedDefinition, { readonly kind: K }> =>
      definition.kind === kind,
  );
}

export interface ResolvedAgent {
  readonly channels: readonly ResolvedChannelDefinition[];
  readonly config?: ResolvedAgentDefinition;
  readonly connections: readonly ResolvedConnectionDefinition[];
  readonly definitions: readonly ResolvedDefinition[];
  readonly metadata: ResolvedAgentMetadata;
  readonly instructions: readonly ResolvedInstructionsDefinition[];
  readonly sandbox: ResolvedSandboxDefinition;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  readonly skills: readonly ResolvedSkillDefinition[];
  readonly tools: readonly ResolvedToolDefinition[];
  readonly workspaceSpec: WorkspaceRuntimeSpec;
}
