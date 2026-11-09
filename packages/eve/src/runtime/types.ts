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
import type { ToolModelOutput } from "#tools/definition.js";
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

/**
 * Runtime-owned source ref describing one additive config module import.
 */
export type ResolvedModuleSourceRef = Readonly<ModuleSourceRef>;

/**
 * Authored instructions prompt resolved from `instructions.md` or
 * `instructions.{ts,...}`.
 *
 * Module-backed instructions sources are executed once at build time —
 * the resulting content is captured here. Runtime never re-evaluates
 * the module.
 */
export type ResolvedInstructionsDefinition = Readonly<
  SourceRef & {
    content: string;
    name: string;
    owner: AgentSourceOwner;
    role: "system" | "user";
  } & (Omit<MarkdownSourceRef<undefined>, "definition"> | ModuleSourceRef)
>;

/**
 * Runtime-owned skill metadata resolved from markdown, TypeScript, or a skill
 * package manifest entry.
 */
export type ResolvedSkillDefinition = Readonly<
  NamedSkillDefinition &
    (Omit<MarkdownSourceRef<undefined>, "definition"> | ModuleSourceRef | SkillPackageSourceRef) & {
      metadata?: Readonly<Record<string, string>>;
    }
>;

/**
 * Runtime-owned authored schedule definition resolved from compiler artifacts.
 *
 * A schedule has exactly one of `markdown` (fire-and-forget agent run)
 * or `hasRun: true` (authored handler). For the handler form the
 * runtime loads the schedule's module and invokes `definition.run` with
 * a {@link ScheduleHandlerArgs}-shaped argument; for the markdown form
 * the dispatcher synthesizes a channel-less SCHEDULE_ADAPTER run.
 */
export type ResolvedScheduleDefinition = Readonly<
  SourceRef & {
    readonly cron: string;
    readonly name: string;
    readonly markdown?: string;
    readonly hasRun: boolean;
    readonly sourceKind: "markdown" | "module";
  } & (Omit<MarkdownSourceRef<undefined>, "definition"> | ModuleSourceRef)
>;

/**
 * Runtime-owned authored connection definition resolved from a compiled
 * module map.
 *
 * Both `authorization` and `headers` are optional — a connection to a
 * server that requires no authentication (e.g. localhost) may omit both.
 */
/** A connection's event watching, checked once when the connection resolves. */
export interface ResolvedConnectionEvents {
  readonly callbacks: ConnectionEvents;
  /** The static Connect authorization every watch subscribes and runs under. */
  readonly authorization: Readonly<AuthorizationDefinition>;
  readonly connector: string;
  readonly backend: ConnectionEventsBackend;
}

export interface ResolvedConnectionDefinition extends ResolvedModuleSourceRef {
  readonly experimental_events?: ResolvedConnectionEvents;
  readonly protocolVersionDiscovery?: boolean;
  /** MCP only: send the turn's principals in `eve-forwarded-principal`. */
  readonly forwardPrincipal?: boolean;
  readonly approval?: Approval;
  readonly authorization?: Readonly<AuthorizationDefinition> | ConnectionAuthResolver;
  readonly connectionName: string;
  readonly description: string;
  readonly headers?: Readonly<HeadersDefinition>;
  /** Opaque identity used to pin authorization and credential state to this resolved instance. */
  readonly instanceId?: string;
  readonly toolCall?: Readonly<ConnectionToolCallDefinition>;
  /**
   * Wire protocol. Selects the runtime client implementation. `tools`
   * carries the connection's operation/tool filter regardless of
   * protocol (sourced from `tools` on MCP connections, `operations` on
   * OpenAPI connections).
   */
  readonly protocol: ConnectionProtocol;
  /**
   * OpenAPI document source (URL or inline object). Present only for
   * `protocol: "openapi"` connections; the OpenAPI client fetches and
   * parses it on first use.
   */
  readonly spec?: OpenAPISpecSource;
  readonly tools?: Readonly<ToolFilterDefinition>;
  readonly url: string;
}

/**
 * Runtime-owned sandbox definition resolved from a compiled module map.
 * Independent definitions carry their exported environment; parent definitions
 * explicitly inherit the dispatching agent's sandbox.
 */
type ResolvedSandboxDefinitionBase = ResolvedModuleSourceRef & {
  readonly revisionHash: string;
  readonly selector: SandboxSelector;
};

export type ResolvedSandboxDefinition = ResolvedSandboxDefinitionBase &
  (
    | { readonly environment: SandboxEnvironmentIdentity; readonly kind: "independent" }
    | { readonly kind: "parent" }
  );

/**
 * Runtime-owned tool definition resolved from the selected compiled source graph.
 * A tool without `execute` is surfaced to the client and never executed by eve.
 */
export type ResolvedToolDefinition = Readonly<
  Omit<
    Optional<InternalToolDefinitionWithExecuteFn<unknown, unknown>, "execute">,
    "inputSchema" | "outputSchema"
  >
> &
  ResolvedModuleSourceRef & {
    readonly behavior?: CompiledToolBehavior;
    readonly owner: AgentSourceOwner;
    /**
     * Validated runtime input schema. Compiled and durable JSON Schemas are
     * rehydrated before entering this runtime-owned definition.
     */
    readonly inputSchema: ToolSchema | null;
    /** Framework-owned input projected before a workflow tool executor starts. */
    readonly executeInput?: (input: unknown) => JsonValue;
    /** Presentation projected from tool lifecycle values. */
    readonly label?: import("#tools/definition.js").InternalToolLabelDefinition | false;
    /**
     * Optional validated runtime output schema.
     */
    readonly outputSchema?: ToolSchema;
    /**
     * Optional per-tool approval gate. When set, determines whether user
     * approval is required before executing this tool. See
     * {@link Approval} for the shared callback contract.
     */
    readonly approval?: Approval;
    /**
     * Optional projection that controls what the model sees as the tool
     * result. The full `execute` return is still visible to channel event
     * handlers and the stream. See {@link ToolModelOutput}.
     */
    readonly toModelOutput?: (output: unknown) => ToolModelOutput | Promise<ToolModelOutput>;
  };

/**
 * Runtime-owned authored hook definition resolved from a compiled module
 * map. Carries live stream-event handlers reattached from the authored
 * module's exported nested maps.
 *
 * Per-handler validation runs at resolve time inside
 * {@link resolveHookDefinition}; missing handlers are simply absent from
 * the resolved maps.
 */
/** A content renderer, with its functions reattached from its module. */
export interface ResolvedRendererDefinition extends ResolvedModuleSourceRef {
  readonly slug: string;
  readonly extensionNamespace?: string;
  readonly renderer: import("#public/definitions/content-renderer.js").ContentRendererDefinition;
}

export interface ResolvedHookDefinition extends ResolvedModuleSourceRef {
  /**
   * Path-relative slug used for diagnostics and ordering.
   */
  readonly slug: string;
  /**
   * Stream-event subscribers reattached from the authored
   * `events: { ... }` map, keyed by event type. Includes the `*`
   * wildcard if declared. Unknown keys are accepted at resolve time
   * and ignored at dispatch time.
   */
  readonly events: Readonly<Record<string, StreamEventHook<SessionEvent>>>;
}

/** A `defineDynamic()` function, loaded from its module. */
export type DynamicEvaluateFn = (ctx: never) => unknown;

/** A `defineDynamic()` export reattached from its compiled module. */
export interface ResolvedDynamicSource extends Readonly<ModuleSourceRef> {
  readonly evaluate: DynamicEvaluateFn;
}

/**
 * Runtime-owned authored channel definition resolved from the compiled
 * module map. Channels are uniform fetch handlers — there is no per-platform
 * subtype.
 *
 * Supports both old Route-style `fetch` handlers and new CompiledChannel
 * route handlers. The dispatch layer checks for `handler` first.
 */
export interface ResolvedChannelDefinition extends ResolvedModuleSourceRef {
  readonly name: string;
  readonly method: ChannelRouteMethod;
  readonly adapter?: ChannelAdapter;
  readonly turnPolicy?: CompiledChannel["turnPolicy"];
  readonly cors?: NormalizedChannelCorsOptions;
  readonly urlPath: string;
  readonly fetch: (req: Request, ctx: RouteContext) => Promise<Response>;
  /**
   * Universal entry point for new sessions, called by cross-channel
   * initiators (the schedule dispatcher today). Typed precisely as
   * {@link CompiledChannel.receive} — `(input, ctx) => Session` —
   * so any caller passing the wrong context shape is a typecheck error,
   * not a runtime crash.
   *
   * Old Route-style channels do not flow `receive` through here. The
   * resolver sets it to `undefined` for those; callers that need
   * `receive` then throw with a clear error rather than silently
   * accepting a different shape.
   */
  readonly receive?: CompiledChannel["receive"];
  /**
   * Reference to the authored {@link CompiledChannel} value the channel
   * module exported. Preserved so callers of `ctx.to(channel, target)`
   * can identify a target by the same imported reference. `undefined`
   * for framework-internal channels constructed without going through
   * `defineChannel`.
   */
  readonly definition?: CompiledChannel;
  /**
   * New-style route handler from CompiledChannel. When present, the
   * dispatch layer uses this instead of `fetch`.
   */
  readonly handler?: RouteHandler;
  /**
   * New-style websocket route handler from CompiledChannel. Present only for
   * routes declared via `WS()`.
   */
  readonly websocket?: WebSocketRouteHandler;
}

/**
 * Runtime-owned local subagent node resolved from one compiled local
 * subagent package.
 */
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

/**
 * Runtime-owned remote subagent entry resolved from one module-backed remote
 * definition in the parent node's compiled manifest.
 */
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

/**
 * Runtime-owned delegation entry exposed to the model as a subagent-shaped tool.
 */
export type ResolvedRuntimeDelegationNode =
  | ResolvedRuntimeRemoteAgentNode
  | ResolvedRuntimeSubagentNode;

export type ResolvedDynamicSubagentDefinition = ResolvedDynamicSource;

/**
 * Runtime-owned additive agent configuration resolved from `agent.ts`.
 */
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

/**
 * Stable runtime metadata preserved alongside the resolved authored agent.
 */
interface ResolvedAgentMetadata {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly diagnosticsSummary: DiscoverDiagnosticsSummary;
}

export type ResolvedMemoryDefinition = Readonly<
  MemoryDefinition &
    ModuleSourceRef & {
      readonly slot: string;
      /** It offers its provider's tools: no `tools/<slot>.ts` replaces or disables them. */
      readonly offersTools?: true;
    }
>;

/** An `agent/schedules/` collection, with its definition reattached and stamped. */
export interface ResolvedScheduleCollection extends Readonly<ModuleSourceRef> {
  readonly name: string;
  readonly definition: DynamicSchedulesDefinition<unknown>;
  /** It offers the model its tools: `tool` isn't `false`, and no tool file replaces them. */
  readonly offersTools?: true;
}

/** The `defineDynamic()` file kinds: each returns what it defines when eve asks. */
export type DynamicDefinitionKind = "connection" | "instructions" | "skill" | "tool";

/** A `defineDynamic()` file the agent declares, with its function reattached. */
export interface ResolvedDynamicDefinition<
  K extends DynamicDefinitionKind = DynamicDefinitionKind,
> extends ResolvedDynamicSource {
  readonly kind: K;
  readonly slug: string;
  /** An extension's namespace, which the names of what a map returns take. */
  readonly extensionNamespace?: string;
}

/** A file the agent declares that eve asks at runtime, with its code reattached. */
export type ResolvedDefinition =
  | { [K in DynamicDefinitionKind]: ResolvedDynamicDefinition<K> }[DynamicDefinitionKind]
  | (ResolvedHookDefinition & { readonly kind: "hook" })
  | (ResolvedRendererDefinition & { readonly kind: "renderer" })
  | (ResolvedMemoryDefinition & { readonly kind: "memory" })
  | (ResolvedScheduleCollection & { readonly kind: "schedules" });

/** The agent's definitions of one kind, in the order it declares them. */
export function declared<K extends ResolvedDefinition["kind"]>(
  agent: Pick<ResolvedAgent, "definitions">,
  kind: K,
): readonly Extract<ResolvedDefinition, { readonly kind: K }>[] {
  return agent.definitions.filter(
    (definition): definition is Extract<ResolvedDefinition, { readonly kind: K }> =>
      definition.kind === kind,
  );
}

/**
 * Runtime-owned authored agent model resolved from compiler artifacts.
 */
export interface ResolvedAgent {
  readonly channels: readonly ResolvedChannelDefinition[];
  readonly config?: ResolvedAgentDefinition;
  readonly connections: readonly ResolvedConnectionDefinition[];
  /** The files eve asks at runtime, in the order the agent declares them. */
  readonly definitions: readonly ResolvedDefinition[];
  readonly metadata: ResolvedAgentMetadata;
  /**
   * Authored instructions prompt resolved from `instructions.md` or
   * `instructions.{ts,...}`, or `undefined` when the agent does not
   * declare one.
   */
  readonly instructions: readonly ResolvedInstructionsDefinition[];
  readonly sandbox: ResolvedSandboxDefinition;
  /**
   * Byte-free descriptor for the compiled workspace resource tree owned
   * by this agent's graph node. The prewarm orchestrator resolves the
   * descriptor's logical path against the active compiled artifacts
   * source and writes the contents into the sandbox template snapshot.
   */
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  readonly skills: readonly ResolvedSkillDefinition[];
  readonly tools: readonly ResolvedToolDefinition[];
  readonly workspaceSpec: WorkspaceRuntimeSpec;
}
