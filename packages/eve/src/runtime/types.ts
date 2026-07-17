import type { FlexibleSchema } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { CompiledChannel } from "#channel/compiled-channel.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { HeadersValue } from "#client/types.js";
import type { DiscoverDiagnosticsSummary } from "#discover/diagnostics.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { ChannelRouteMethod, RouteContext } from "#public/definitions/channel.js";
import type { RouteHandler, WebSocketRouteHandler } from "#channel/routes.js";
import type { OutboundAuthFn } from "#public/agents/auth.js";
import type { StreamEventHook } from "#public/definitions/hook.js";
import type { Approval } from "#public/definitions/approval.js";
import type { ToolModelOutput } from "#public/definitions/tool.js";
import type {
  AuthorizationDefinition,
  ConnectionAuthResolver,
  ConnectionProtocol,
  HeadersDefinition,
  ToolFilterDefinition,
} from "#runtime/connections/types.js";
import type { OpenAPISpecSource } from "#public/definitions/connections/openapi.js";
import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";
import type { JsonObject } from "#shared/json.js";
import type { Optional } from "#shared/optional.js";
import type { Node } from "#shared/node.js";
import type {
  SourceRef,
  ModuleSourceRef,
  SkillPackageSourceRef,
  MarkdownSourceRef,
} from "#shared/source-ref.js";
import type { NamedSkillDefinition } from "#shared/skill-definition.js";
import type { InternalAgentDefinition } from "#shared/agent-definition.js";
import type { RuntimeDynamicModelReference } from "#runtime/agent/bootstrap.js";
import type { InternalToolDefinitionWithExecuteFn } from "#shared/tool-definition.js";
import type { SandboxBackend } from "#shared/sandbox-backend.js";
import type { SandboxBootstrapContext, SandboxSessionContext } from "#shared/sandbox-definition.js";

/**
 * Runtime-owned source ref describing one additive config module import.
 */
export type ResolvedModuleSourceRef = Readonly<ModuleSourceRef>;

/**
 * Authored instructions prompt resolved from `instructions.md` or
 * `instructions.{ts,...}`.
 *
 * Module-backed instructions sources are executed once at build time —
 * the resulting markdown is captured here. Runtime never re-evaluates
 * the module.
 */
export type ResolvedInstructionsDefinition = Readonly<
  SourceRef & {
    name: string;
    markdown: string;
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
export interface ResolvedConnectionDefinition extends ResolvedModuleSourceRef {
  readonly approval?: Approval;
  readonly authorization?: Readonly<AuthorizationDefinition> | ConnectionAuthResolver;
  readonly connectionName: string;
  readonly description: string;
  readonly headers?: Readonly<HeadersDefinition>;
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
 * Runtime-owned authored sandbox definition resolved from a compiled module
 * map.
 *
 * The resolved `backend` is non-optional: every sandbox in the runtime
 * graph carries a concrete SandboxBackend value, even when the
 * authored definition omits `backend`. The unauthored case is filled
 * in by `defaultSandbox()` (which itself selects between
 * `vercel()`, `docker()`, `microsandbox()`, and `justbash()` based on the current
 * environment).
 */
export type ResolvedSandboxDefinition = ResolvedModuleSourceRef & {
  readonly bootstrap?: (input: SandboxBootstrapContext) => Promise<void> | void;
  readonly revalidationKey?: string;
  readonly sourceHash?: string;
  /**
   * Resolved backend value. The authored `SandboxDefinition.backend`
   * accepts either a `SandboxBackend` or a `() => SandboxBackend`; by
   * the time it reaches the runtime the function form has been
   * unwrapped via `lazyBackend(...)` so consumers always see a plain
   * value.
   */
  readonly backend: SandboxBackend;
  readonly description?: string;
  readonly onSession?: (input: SandboxSessionContext) => Promise<void> | void;
};

/**
 * Runtime-owned tool definition resolved from a compiled module map or
 * declared by the framework catalog.
 * A tool without `execute` is surfaced to the client and never executed by eve.
 */
export type ResolvedToolDefinition = Readonly<
  Optional<InternalToolDefinitionWithExecuteFn<unknown, unknown>, "execute">
> &
  ResolvedModuleSourceRef & {
    /**
     * Optional live Standard Schema reattached from the authored module at
     * resolve time. When present, the AI SDK uses it for both JSON schema
     * extraction and runtime validation with transforms/defaults.
     */
    readonly inputStandardSchema?: FlexibleSchema;
    /**
     * Optional live Standard Schema reattached from the authored module at
     * resolve time for tool output typing/validation.
     */
    readonly outputStandardSchema?: FlexibleSchema;
    /**
     * Optional per-tool approval gate. When set, determines whether user
     * approval is required before executing this tool. See
     * {@link Approval} for the shared callback contract.
     */
    readonly approval?: Approval;
    /**
     * Optional function that derives a compound approval key from the tool
     * input. When present, the runtime records this key (instead of just
     * the tool name) in the session's approved-tools set after the user
     * approves the tool call.
     *
     * This enables input-aware approval scoping. For example, a tool
     * can record `"tool:<scope>"` so approval is per-scope rather
     * than blanket.
     */
    readonly approvalKey?: (toolInput: Readonly<Record<string, unknown>>) => string;
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
  readonly events: Readonly<Record<string, StreamEventHook<HandleMessageStreamEvent>>>;
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
  readonly cors?: NormalizedChannelCorsOptions;
  readonly urlPath: string;
  readonly fetch: (req: Request, ctx: RouteContext) => Promise<Response>;
  /**
   * Universal entry point for new sessions, called by cross-channel
   * initiators (the schedule dispatcher today). Typed precisely as
   * {@link CompiledChannel.receive} — `(input, { send }) => Session` —
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
   * module exported. Preserved so callers of `args.receive(channel, …)`
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
      description: string;
      kind: "subagent";
      name: string;
    }
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
      headers?: HeadersValue;
      kind: "remote";
      name: string;
      outputSchema?: JsonObject;
      path: string;
      url: string;
    }
>;

/**
 * Runtime-owned delegation entry exposed to the model as a subagent-shaped tool.
 */
export type ResolvedRuntimeDelegationNode =
  | ResolvedRuntimeRemoteAgentNode
  | ResolvedRuntimeSubagentNode;

/**
 * Runtime-owned additive agent configuration resolved from `agent.ts`.
 */
export type ResolvedAgentDefinition = Readonly<
  Omit<InternalAgentDefinition, "build" | "source"> & {
    dynamicModel?: RuntimeDynamicModelReference;
    source?: Readonly<NonNullable<InternalAgentDefinition["source"]>>;
  }
>;

/**
 * Stable runtime metadata preserved alongside the resolved authored agent.
 */
interface ResolvedAgentMetadata {
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly diagnosticsSummary: DiscoverDiagnosticsSummary;
}

/**
 * Runtime resolver for dynamic tools declared via `defineDynamic({ events })`.
 * Carries the live event handler functions loaded from the compiled module.
 */
export interface ResolvedDynamicToolResolver extends Readonly<ModuleSourceRef> {
  readonly slug: string;
  readonly eventNames: readonly string[];
  readonly events: Readonly<
    Record<string, (event: unknown, ctx: unknown) => unknown | Promise<unknown>>
  >;
  /**
   * Mount namespace when this resolver comes from an extension. Names of tools
   * the resolver produces are prefixed with `${extensionNamespace}__`.
   */
  readonly extensionNamespace?: string;
}

/**
 * Runtime resolver for dynamic skills declared via `defineDynamic({ events })`
 * in `agent/skills/`. Carries the live event handler functions loaded from the
 * compiled module.
 */
export interface ResolvedDynamicSkillResolver extends Readonly<ModuleSourceRef> {
  readonly slug: string;
  readonly eventNames: readonly string[];
  readonly events: Readonly<
    Record<string, (event: unknown, ctx: unknown) => unknown | Promise<unknown>>
  >;
  /**
   * Mount namespace when this resolver comes from an extension. Names of skills
   * a map resolver produces are prefixed with `${extensionNamespace}__`.
   */
  readonly extensionNamespace?: string;
}

/**
 * Runtime resolver for dynamic instructions declared via
 * `defineDynamic({ events })` in `agent/instructions/`. Carries the live
 * event handler functions loaded from the compiled module.
 */
export interface ResolvedDynamicInstructionsResolver extends Readonly<ModuleSourceRef> {
  readonly slug: string;
  readonly eventNames: readonly string[];
  readonly events: Readonly<
    Record<string, (event: unknown, ctx: unknown) => unknown | Promise<unknown>>
  >;
}

/**
 * Runtime-owned authored agent model resolved from compiler artifacts.
 */
export interface ResolvedAgent {
  readonly channels: readonly ResolvedChannelDefinition[];
  readonly config: ResolvedAgentDefinition;
  readonly connections: readonly ResolvedConnectionDefinition[];
  /**
   * Logical names of framework-provided channels the author opted out of by
   * exporting `disableRoute()` from a file in `agent/channels/`. Each
   * entry is the slash-joined slug path of one such file. The graph
   * resolver uses this list to filter the framework default channel set.
   */
  readonly disabledFrameworkChannels: readonly string[];
  /**
   * Names of framework-provided tools the author opted out of by exporting
   * `disableTool()` from a file in `agent/tools/`. Each entry is the
   * filename slug of one such file. The graph resolver uses this list to
   * filter the framework default tool set.
   */
  readonly disabledFrameworkTools: readonly string[];
  /**
   * Configuration for the experimental framework `Workflow` orchestration
   * tool. Present when an authored tool module exports
   * `experimental_workflow(...)`.
   */
  readonly workflowTool?: {
    readonly maxSubagents?: number;
  };
  readonly dynamicInstructionsResolvers: readonly ResolvedDynamicInstructionsResolver[];
  readonly dynamicSkillResolvers: readonly ResolvedDynamicSkillResolver[];
  readonly dynamicToolResolvers: readonly ResolvedDynamicToolResolver[];
  readonly metadata: ResolvedAgentMetadata;
  /**
   * Authored instructions prompt resolved from `instructions.md` or
   * `instructions.{ts,...}`, or `undefined` when the agent does not
   * declare one.
   */
  readonly instructions?: ResolvedInstructionsDefinition;
  /**
   * Authored sandbox override for this agent, when one exists. `null`
   * means the agent uses the framework default sandbox unchanged.
   */
  readonly sandbox: ResolvedSandboxDefinition | null;
  /**
   * Byte-free descriptor for the compiled workspace resource tree owned
   * by this agent's graph node. The prewarm orchestrator resolves the
   * descriptor's logical path against the active compiled artifacts
   * source and writes the contents into the sandbox template snapshot.
   */
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  readonly hooks: readonly ResolvedHookDefinition[];
  readonly skills: readonly ResolvedSkillDefinition[];
  readonly tools: readonly ResolvedToolDefinition[];
  readonly workspaceSpec: WorkspaceRuntimeSpec;
}
