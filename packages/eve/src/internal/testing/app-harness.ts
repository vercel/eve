import type { ChannelAdapter } from "#channel/adapter.js";
import {
  compileFromMemory,
  type CompileFromMemoryInput,
} from "#internal/testing/compile-from-memory.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map-schema.js";
import type { ProgrammaticAgentModule } from "#compiler/source-graph.js";
import type { SessionParent, SessionTurn } from "#context/keys.js";
import { installBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { createSandboxPreparedArtifactsManifest } from "#shared/sandbox-prepared-artifacts.js";
import type { SandboxAccess } from "#sandbox/state.js";
import {
  createRuntimeSession,
  type RuntimeSession,
  withRuntimeSession,
} from "#runtime/sessions/runtime-session.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";
import { createNodeHarnessTools } from "#execution/node-step.js";
import { serializeInputSchema, serializeOutputSchema } from "#tools/schema.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import {
  defineSandboxProvider,
  type SandboxSessionContext,
  type SandboxSessionIdleOptions,
} from "#sandbox/provider.js";
import {
  buildActiveSessionContext,
  type ActiveSessionInit,
  runWithActiveSessionContext,
} from "#internal/testing/active-session-context.js";
import { mockSandbox, type MockSandbox } from "#internal/testing/mocks/mock-sandbox.js";

interface TestAppDescriptor {
  readonly agent?: {
    readonly definition?: import("#public/definitions/agent.js").AgentDefinition;
    readonly limits?: import("#shared/agent-definition.js").AgentLimitsDefinition;
    readonly model?: string;
    readonly name?: string;
  };
  readonly tools?: readonly ResolvedToolDefinition[];
  readonly modules?: readonly ProgrammaticAgentModule[];
  readonly beforeSandboxStart?: (sessionId: string) => Promise<void>;
  readonly sandboxIdle?: {
    readonly idleTimeoutMs?: number | false;
    readonly onSessionIdle?: (sessionId: string, signal: AbortSignal | undefined) => Promise<void>;
  };
}

export interface RunAsSessionInit {
  readonly sessionId?: string;
  readonly turn?: SessionTurn;
  readonly parent?: SessionParent;
  readonly sandbox?: MockSandbox;
  readonly sandboxAccess?: SandboxAccess;
  readonly channel?: ChannelAdapter<any>;
}

export interface TestRuntime {
  readonly session: RuntimeSession;
  readonly manifest: CompiledAgentManifest;
  readonly moduleMap: CompiledModuleMap;
  readonly tools: readonly ResolvedToolDefinition[];
  run<T>(fn: () => Promise<T> | T): Promise<T>;
  runAsSession<T>(init: RunAsSessionInit | undefined, fn: () => Promise<T> | T): Promise<T>;
  executeTool(
    tool: string | Pick<ResolvedToolDefinition, "name">,
    input: unknown,
  ): Promise<unknown>;
  readonly sandboxCleanups: readonly string[];
  readonly sandboxEvents: readonly string[];
  reset(): void;
}

const DEFAULT_AGENT_NAME = "test-agent";

export const TEST_DEFAULT_MODEL_ID = "openai/gpt-5.4";

const TEST_SANDBOX_PROVIDER_NAME = "eve-test-memory";

function createTestSandboxProvider(
  beforeStart?: (sessionId: string) => Promise<void>,
  idle?: TestAppDescriptor["sandboxIdle"],
) {
  const sessionSandboxes = new Map<string, MockSandbox>();
  const endedSessionIds: string[] = [];
  const events: string[] = [];

  function connect(sessionId: string) {
    let sandbox = sessionSandboxes.get(sessionId);
    if (sandbox === undefined) {
      sandbox = mockSandbox({ id: sessionId });
      sessionSandboxes.set(sessionId, sandbox);
    }
    return sandbox.connection;
  }

  const provider = defineSandboxProvider({
    name: TEST_SANDBOX_PROVIDER_NAME,
    environment: () => ({
      async onSessionEnd(context, _state, { reason }) {
        if (reason === "deleted") events.push(`delete:${context.session.id}`);
        else {
          events.push(`end:${context.session.id}`);
          endedSessionIds.push(context.session.id);
        }
        sessionSandboxes.delete(context.session.id);
      },
      async prepare() {
        return null;
      },
      async start(context) {
        await beforeStart?.(context.session.id);
        events.push(`start:${context.session.id}`);
        return { connection: connect(context.session.id), state: null };
      },
      async resume(context) {
        events.push(`resume:${context.session.id}`);
        return connect(context.session.id);
      },
      ...(idle !== undefined && {
        async onSessionIdle(
          context: SandboxSessionContext,
          _state: unknown,
          options: SandboxSessionIdleOptions,
        ) {
          events.push(`idle:${context.session.id}`);
          await idle.onSessionIdle?.(context.session.id, options.signal);
        },
      }),
    }),
  });
  return {
    clear: () => {
      sessionSandboxes.clear();
      endedSessionIds.length = 0;
      events.length = 0;
    },
    endedSessionIds,
    events,
    provider,
  };
}

export async function createTestRuntime(descriptor: TestAppDescriptor = {}): Promise<TestRuntime> {
  const sandboxes = createTestSandboxProvider(
    descriptor.beforeSandboxStart,
    descriptor.sandboxIdle,
  );
  const compileInput: CompileFromMemoryInput = {
    name: descriptor.agent?.name ?? DEFAULT_AGENT_NAME,
    model: descriptor.agent?.model ?? TEST_DEFAULT_MODEL_ID,
    limits: descriptor.agent?.limits,
    agent: descriptor.agent?.definition,
    modules: [
      {
        loadNamespace: async () => {
          const environment = sandboxes.provider.environment(
            descriptor.sandboxIdle?.idleTimeoutMs === undefined
              ? undefined
              : { idleTimeoutMs: descriptor.sandboxIdle.idleTimeoutMs },
          );
          return {
            environment,
            default: defineSandbox(({ session }) => {
              sandboxes.events.push(`definition:${session.id}`);
              return environment.open();
            }),
          };
        },
        logicalPath: "sandbox.ts",
      },
      ...(descriptor.modules ?? []),
    ],
  };

  if (descriptor.tools !== undefined && descriptor.tools.length > 0) {
    Object.assign(compileInput, {
      tools: descriptor.tools.map((tool) => ({
        name: tool.name,
        label:
          tool.label === false
            ? false
            : tool.label?.start === undefined
              ? undefined
              : { start: tool.label.start },
        description: tool.description,
        execute: tool.execute,
        inputSchema: serializeInputSchema(tool.inputSchema),
        outputSchema:
          tool.outputSchema === undefined ? undefined : serializeOutputSchema(tool.outputSchema),
        approval: tool.approval,
        toModelOutput: tool.toModelOutput,
      })),
    });
  }

  const { manifest, modelMetadata, moduleMap } = await compileFromMemory(compileInput);
  const session = createRuntimeSession(descriptor.agent?.name ?? DEFAULT_AGENT_NAME);
  const tools = descriptor.tools ?? [];

  function install(): void {
    installBundledCompiledArtifacts({
      manifest,
      modelMetadata,
      moduleMap,
      sandboxPreparedArtifacts: createSandboxPreparedArtifactsManifest([
        { artifact: null, nodeId: "__root__", providerName: TEST_SANDBOX_PROVIDER_NAME },
      ]),
    });
  }

  async function run<T>(fn: () => Promise<T> | T): Promise<T> {
    return await withRuntimeSession(session, async () => {
      install();
      return await fn();
    });
  }

  async function runAsSession<T>(
    init: RunAsSessionInit | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const sessionInit: ActiveSessionInit = buildActiveSessionContextInit(init);

    return await run(async () => {
      return await runWithActiveSessionContext(sessionInit, fn);
    });
  }

  function reset(): void {
    session.compiledArtifacts = null;
    session.bundleCache.clear();
    session.bundleCacheKeyBySourceKey.clear();
    sandboxes.clear();
    session.describedAgents.clear();
  }

  async function executeTool(
    tool: string | Pick<ResolvedToolDefinition, "name">,
    input: unknown,
  ): Promise<unknown> {
    const name = typeof tool === "string" ? tool : tool.name;
    return await run(async () => {
      const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
      const definition = createNodeHarnessTools({ node: graph.root }).get(name);
      if (definition === undefined) throw new Error(`Tool "${name}" is not installed.`);
      if (definition.execute === undefined) throw new Error(`Tool "${name}" is not executable.`);
      return await definition.execute(input, { messages: [], toolCallId: "call_test" });
    });
  }

  return {
    executeTool,
    manifest,
    moduleMap,
    reset,
    run,
    runAsSession,
    sandboxCleanups: sandboxes.endedSessionIds,
    sandboxEvents: sandboxes.events,
    session,
    tools,
  };
}

export { buildActiveSessionContext };

function buildActiveSessionContextInit(init: RunAsSessionInit | undefined): ActiveSessionInit {
  const sessionId = init?.sessionId ?? "session_test";
  const turn = init?.turn ?? { id: "turn_test_001", sequence: 1 };
  const sandboxAccess = init?.sandboxAccess ?? init?.sandbox?.access;

  const mutable: {
    sessionId: string;
    turn: SessionTurn;
    parent?: SessionParent;
    sandbox?: SandboxAccess;
    channel?: ChannelAdapter;
  } = {
    sessionId,
    turn,
  };

  if (init?.parent !== undefined) {
    mutable.parent = init.parent;
  }

  if (sandboxAccess !== undefined) {
    mutable.sandbox = sandboxAccess;
  }

  if (init?.channel !== undefined) {
    mutable.channel = init.channel;
  }

  return mutable;
}
