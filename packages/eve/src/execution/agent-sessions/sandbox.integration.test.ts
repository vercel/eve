import { afterEach, describe, expect, it } from "vitest";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { createProgrammaticCompiledModuleMap } from "#compiler/module-map.js";
import {
  createAgentSourceRegistry,
  defineProgrammaticAgentSource,
} from "#compiler/source-graph.js";
import { frameworkAgentSourceRegistry } from "#framework/sources/registry.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { installBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { createSandboxPreparedArtifactsManifest } from "#shared/sandbox-prepared-artifacts.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { sandboxDelegateWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { sandboxInboxAgentDefinition as definition } from "#internal/testing/sandbox-model-fixture.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { agent } from "#tools/framework/agent.js";
import { workflowEntry } from "#execution/session/entry.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { getWorld, start, resumeHook } from "#internal/workflow/runtime.js";

// Only model output is scripted. Sessions, workflow tools, steps, inboxes,
// reply hooks, and the sandbox provider use the production runtime.
const ALICE = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user" as const,
};
const BOB = { ...ALICE, principalId: "bob" };

function module(logicalPath: string, value: unknown) {
  return { logicalPath, loadNamespace: async () => ({ default: value }) };
}
function delegateTool(description: string) {
  return defineWorkflowTool({
    description,
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" }, message: { type: "string" } },
      required: ["target", "message"],
    },
    execute: sandboxDelegateWorkflow,
  });
}

function childDefinition(description: string) {
  const fixture = new URL("../../internal/testing/sandbox-model-fixture.ts", import.meta.url)
    .pathname;
  return `import { sandboxInboxAgentDefinition } from ${JSON.stringify(fixture)}; export default { ...sandboxInboxAgentDefinition, description: ${JSON.stringify(description)} };`;
}
function handle() {
  return {
    sandbox: mockSandbox().session,
    onSandboxDelete: async () => {},
    onSandboxStop: async () => {},
    onRuntimeShutdown: async () => {},
  };
}

describe("sandbox requests over the real local workflow world", () => {
  const createAppRoot = useTemporaryAppRoots();
  afterEach(() => shutdownActiveSandboxHandles());
  it.each(["builtin", "authored", "nested"])(
    "finishes %s child startup while its ancestors wait",
    async (path) => {
      const app = await createAppRoot("eve-sandbox-inbox-", {
        files: {
          "agent/subagents/leaf/agent.ts": childDefinition("leaf"),
          "agent/subagents/leaf/sandbox.ts":
            'import { defineParentSandbox } from "eve/sandbox"; export default defineParentSandbox();',
          "agent/subagents/middle/agent.ts": childDefinition("middle"),
          "agent/subagents/middle/sandbox.ts":
            'import { defineParentSandbox } from "eve/sandbox"; export default defineParentSandbox();',
          "agent/subagents/middle/subagents/leaf/agent.ts": childDefinition("leaf"),
          "agent/subagents/middle/subagents/leaf/sandbox.ts":
            'import { defineParentSandbox } from "eve/sandbox"; export default defineParentSandbox();',
        },
      });
      const observedCallers: (string | undefined)[] = [];
      const provider = defineSandboxProvider({
        name: "inbox-test",
        environment: () => ({
          prepare: async () => null,
          start: async () => ({ state: null, handle: handle() }),
          resume: async () => handle(),
        }),
      });
      const environment = provider.environment();
      const registry = createAgentSourceRegistry([
        {
          applyTo: "all-local-nodes",
          source: defineProgrammaticAgentSource({
            id: "shared",
            revision: "1",
            modules: [
              module("tools/agent.ts", agent),
              module("tools/delegate_child.ts", delegateTool("Delegate to a child.")),
              module("tools/delegate_grandchild.ts", delegateTool("Delegate to a grandchild.")),
            ],
          }),
        },
        {
          applyTo: "root",
          source: defineProgrammaticAgentSource({
            id: "root-sandbox",
            revision: "1",
            modules: [
              module("agent.ts", definition),
              {
                logicalPath: "sandbox.ts",
                loadNamespace: async () => ({
                  environment,
                  default: defineSandbox((ctx) => {
                    observedCallers.push(ctx.session.auth.current?.principalId);
                    return environment.open();
                  }),
                }),
              },
            ],
          }),
        },
      ]);
      const discovered = await discoverAgent(app);
      const manifest = await compileAgentManifest(discovered.manifest, {
        sourceRegistries: [registry],
      });
      const moduleMap = await createProgrammaticCompiledModuleMap(manifest, [
        frameworkAgentSourceRegistry,
        registry,
      ]);
      const session = createRuntimeSession();
      await withRuntimeSession(session, async () => {
        installBundledCompiledArtifacts({
          manifest,
          moduleMap,
          sandboxPreparedArtifacts: createSandboxPreparedArtifactsManifest([
            { artifact: null, nodeId: "__root__", providerName: "inbox-test" },
          ]),
        });
        const run = await start(workflowEntry, [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: { message: "hello" },
            serializedContext: buildSerializedContext({ auth: ALICE, channelKind: "http" }),
            sessionTimeoutMs: false,
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const initial = await withTimeout(stream.nextTurn(), "Alice's initial turn");
          expect(filterEventsByType(initial, "turn.completed")).toHaveLength(1);
          expect(observedCallers).toEqual([]);
          await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
            kind: "send",
            auth: BOB,
            payload: { message: path },
          });
          const events = await withTimeout(stream.nextTurn(), `${path} Bob sandbox child turn`);
          expect(observedCallers).toEqual(["bob"]);
          expect(filterEventsByType(events, "turn.failed")).toHaveLength(0);
          expect(filterEventsByType(events, "session.failed")).toHaveLength(0);
          expect(filterEventsByType(events, "agent.started")).toHaveLength(1);
          expect(filterEventsByType(events, "turn.completed")).toHaveLength(1);
          // The owner really received the request and ran its initialization step;
          // these records come from @workflow/world-local, not a mocked dispatcher.
          const world = await getWorld();
          const steps = await world.steps.list({ runId: run.runId });
          expect(
            steps.data.filter((step) => step.stepName.includes("initializeOwnerSandboxStep")),
          ).toHaveLength(path === "nested" ? 2 : 1);
          expect(
            steps.data.some((step) => step.stepName.includes("dispatchCoordinationStep")),
          ).toBe(true);
          if (path === "nested") {
            const intermediateId = filterEventsByType(events, "agent.started")[0]!.data.sessionId;
            const intermediateSteps = await world.steps.list({ runId: intermediateId });
            expect(
              intermediateSteps.data.some((step) =>
                step.stepName.includes("dispatchCoordinationStep"),
              ),
            ).toBe(true);
            expect(
              intermediateSteps.data.some((step) =>
                step.stepName.includes("initializeOwnerSandboxStep"),
              ),
            ).toBe(false);
          }
          const received = await world.events.list({ runId: run.runId });
          expect(received.data.some((event) => event.eventType === "hook_received")).toBe(true);
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );
});
