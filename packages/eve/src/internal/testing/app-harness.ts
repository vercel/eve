import type { ChannelAdapter } from "#channel/adapter.js";
import { compileFromMemory, type CompileFromMemoryInput } from "#compiler/compile-from-memory.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import type { ProgrammaticAgentModule } from "#compiler/source-graph.js";
import type { SessionParent, SessionTurn } from "#context/keys.js";
import { installBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
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
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import {
  buildActiveSessionContext,
  type ActiveSessionInit,
  runWithActiveSessionContext,
} from "#internal/testing/active-session-context.js";
import { mockSandbox, type MockSandbox } from "#internal/testing/mocks/mock-sandbox.js";

/**
 * Declarative, in-memory eve app stand-in used by integration tests.
 */

/**
 * Declarative description of a test app.
 *
 * Every field is optional — omitting everything produces an agent named
 * `"test-agent"` that uses the framework default runtime model and declares
 * no tools, skills, or subagents. The harness installs an in-memory sandbox
 * backend so runtime tests never depend on a host container or VM service.
 */
export interface TestAppDescriptor {
  readonly agent?: {
    readonly limits?: {
      readonly maxInputTokensPerSession?: number | false;
      readonly maxOutputTokensPerSession?: number | false;
      readonly maxTokenCostUsdPerSession?: number | false;
      readonly sessionTimeoutMs?: number | false;
    };
    readonly model?: string;
    readonly name?: string;
  };
  /**
   * Authored tools projected into the compiled manifest and available to
   * `runAsSession` for tool dispatch.
   */
  readonly tools?: readonly ResolvedToolDefinition[];
  /** Additional authored modules compiled into the synthetic application. */
  readonly modules?: readonly ProgrammaticAgentModule[];
}

/**
 * Seed for {@link TestRuntime.runAsSession}: describes the authored-context
 * values the runtime should inject before calling the test body.
 */
export interface RunAsSessionInit {
  readonly sessionId?: string;
  readonly turn?: SessionTurn;
  readonly parent?: SessionParent;
  /**
   * Pre-built {@link MockSandbox} — the harness attaches its
   * {@link MockSandbox.access} to `SandboxKey`.
   */
  readonly sandbox?: MockSandbox;
  /**
   * Explicit `SandboxAccess` override. Use this when you want to bypass
   * {@link MockSandbox} entirely (e.g. to use a real backend).
   */
  readonly sandboxAccess?: SandboxAccess;
  /**
   * Channel adapter bound on {@link ChannelKey} for the run. Used by
   * staging / delivery tests that exercise adapter-owned behavior
   * (e.g. attachment resolvers) without spinning up the full runtime.
   */
  readonly channel?: ChannelAdapter<any>;
}

/**
 * A materialized in-memory test app with a pre-built scoped runtime session.
 */
export interface TestRuntime {
  /** The scoped `RuntimeSession` owned by this test app. */
  readonly session: RuntimeSession;
  /** The synthetic compiled-agent manifest installed in the session. */
  readonly manifest: CompiledAgentManifest;
  /** The synthetic compiled module map installed in the session. */
  readonly moduleMap: CompiledModuleMap;
  /** Descriptor-declared tools. Exposed for test-side registry wiring. */
  readonly tools: readonly ResolvedToolDefinition[];
  /**
   * Runs `fn` with this app's runtime session active. Compiled-artifact
   * reads and bundle-cache writes during `fn` target this scoped session,
   * so they cannot leak into the process-default session used by other
   * tests.
   */
  run<T>(fn: () => Promise<T> | T): Promise<T>;
  /**
   * Runs `fn` with the runtime session active **and** an authored context
   * container bound to the current async scope.
   */
  runAsSession<T>(init: RunAsSessionInit | undefined, fn: () => Promise<T> | T): Promise<T>;
  /**
   * Runs a single authored tool through the runtime tool registry and
   * returns whatever its `execute` function produced.
   */
  executeTool(
    tool: string | Pick<ResolvedToolDefinition, "name">,
    input: unknown,
  ): Promise<unknown>;
  /**
   * Clears the compiled-artifact snapshot and bundle cache on this session.
   * Tests that re-use a runtime across multiple assertions can call this to
   * return the session to its initial state.
   */
  reset(): void;
}

const DEFAULT_AGENT_NAME = "test-agent";

/**
 * Builds an in-memory {@link TestRuntime} for the given descriptor.
 *
 * The returned runtime already has its synthetic compiled artifacts
 * installed on its scoped session. Callers invoke `runtime.run(fn)` or
 * `runtime.runAsSession(init, fn)` to execute code under the active
 * session (and, in the latter case, under a seeded authored context).
 */
export const TEST_DEFAULT_MODEL_ID = "openai/gpt-5.4";

const TEST_SANDBOX_PROVIDER = defineSandboxProvider({
  name: "eve-test-memory",
  environment: () => ({
    async prepare() {
      return null;
    },
    async resume(context) {
      return createHandle(context.session.id);
    },
    async start(context) {
      return { handle: createHandle(context.session.id), state: null };
    },
  }),
});

function createHandle(sessionId: string) {
  const sandbox = mockSandbox({ id: sessionId });
  return {
    sandbox: sandbox.session,
    async onSessionDelete(options?: import("#shared/sandbox-provider.js").SandboxDeleteOptions) {
      await sandbox.access.delete?.(options);
    },
    async onSessionStop() {},
    async onRuntimeShutdown() {},
  };
}

export async function createTestRuntime(descriptor: TestAppDescriptor = {}): Promise<TestRuntime> {
  const compileInput: CompileFromMemoryInput = {
    name: descriptor.agent?.name ?? DEFAULT_AGENT_NAME,
    model: descriptor.agent?.model ?? TEST_DEFAULT_MODEL_ID,
    limits: descriptor.agent?.limits,
    modules: [
      {
        loadNamespace: async () => {
          const environment = TEST_SANDBOX_PROVIDER.environment();
          return { environment, default: defineSandbox(() => environment.open()) };
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
        label: tool.label?.start === undefined ? undefined : { start: tool.label.start },
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

  const { manifest, moduleMap } = await compileFromMemory(compileInput);
  const session = createRuntimeSession(descriptor.agent?.name ?? DEFAULT_AGENT_NAME);
  const tools = descriptor.tools ?? [];

  function install(): void {
    installBundledCompiledArtifacts({ manifest, moduleMap });
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
    // Mutate the scoped session directly. The `resetBundledCompiledArtifacts`
    // and `clearCompiledRuntimeAgentBundleCache` helpers both resolve their
    // target via `getActiveRuntimeSession()`, which would require wrapping the
    // work in an async `withRuntimeSession` scope and produce an unhandled
    // rejection if anything inside threw. Operating on the session we already
    // own makes the reset synchronous and exception-safe.
    session.compiledArtifacts = null;
    session.bundleCache.clear();
    session.bundleCacheKeyBySourceKey.clear();
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
    session,
    tools,
  };
}

// Exported for the internal active-session-context helper.
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
