import {
  AgentInfoResultSchema,
  type AgentInfoChannelEntry,
  type AgentInfoNamedDynamicResolverEntry,
  type AgentInfoOwner,
  type AgentInfoRemoteAgentEntry,
  type AgentInfoSource,
  type AgentInfoSubagentEntry,
} from "eve/client";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const STATIC_TOOL_KEYS = [
  "bash|eve.framework-defaults:tools/bash.ts|framework:eve.framework-defaults|tools/bash.ts|module|export=",
  "gizmo__gizmo_budget|ext:gizmo:tools/gizmo_budget.mjs|extension:gizmo:gizmo-extension|tools/gizmo__gizmo_budget.mjs|module|export=",
  "gizmo__gizmo_layout|ext:gizmo:tools/gizmo_layout.mjs|extension:gizmo:gizmo-extension|tools/gizmo__gizmo_layout.mjs|module|export=",
  "gizmo__gizmo_search|tools/gizmo__gizmo_search.ts|application|tools/gizmo__gizmo_search.ts|module|export=",
  "javascript__js_ping|ext:javascript:tools/js_ping.mjs|extension:javascript:js-only-extension|tools/javascript__js_ping.mjs|module|export=",
  "local_ping|tools/local_ping.ts|application|tools/local_ping.ts|module|export=",
  "read_file|eve.framework-defaults:tools/read_file.ts|framework:eve.framework-defaults|tools/read_file.ts|module|export=",
  "toolkit2__toolkit_budget|ext:toolkit2:tools/toolkit_budget.mjs|extension:toolkit2:toolkit-extension|tools/toolkit2__toolkit_budget.mjs|module|export=",
  "toolkit2__toolkit_lookup|ext:toolkit2:tools/toolkit_lookup.mjs|extension:toolkit2:toolkit-extension|tools/toolkit2__toolkit_lookup.mjs|module|export=",
  "toolkit2__toolkit_ping|ext:toolkit2:tools/toolkit_ping.mjs|extension:toolkit2:toolkit-extension|tools/toolkit2__toolkit_ping.mjs|module|export=",
  "toolkit__toolkit_budget|ext:toolkit:tools/toolkit_budget.mjs|extension:toolkit:toolkit-extension|tools/toolkit__toolkit_budget.mjs|module|export=",
  "toolkit__toolkit_lookup|ext:toolkit:tools/toolkit_lookup.mjs|extension:toolkit:toolkit-extension|tools/toolkit__toolkit_lookup.mjs|module|export=",
  "toolkit__toolkit_ping|ext-override:toolkit:tools/toolkit_ping.ts|application|tools/toolkit__toolkit_ping.ts|module|export=",
  "web_fetch|eve.framework-defaults:tools/web_fetch.ts|framework:eve.framework-defaults|tools/web_fetch.ts|module|export=",
  "write_file|eve.framework-defaults:tools/write_file.ts|framework:eve.framework-defaults|tools/write_file.ts|module|export=",
];

const DYNAMIC_TOOL_KEYS = [
  "connection_search|eve.framework-defaults:tools/connection_search.ts|framework:eve.framework-defaults|tools/connection_search.ts|module|export=|events=step.started",
  "toolkit2__toolkit_forecast|ext:toolkit2:tools/toolkit_forecast.mjs|extension:toolkit2:toolkit-extension|tools/toolkit2__toolkit_forecast.mjs|module|export=|events=session.started",
  "toolkit__toolkit_forecast|ext:toolkit:tools/toolkit_forecast.mjs|extension:toolkit:toolkit-extension|tools/toolkit__toolkit_forecast.mjs|module|export=|events=session.started",
];

const STATIC_SKILL_KEYS = [
  "local-guide|skills/local-guide/SKILL.md|application|skills/local-guide/SKILL.md|skill-package|export=",
  "toolkit2__toolkit-guide|ext:toolkit2:skills/toolkit-guide/SKILL.md|extension:toolkit2:toolkit-extension|skills/toolkit2__toolkit-guide/SKILL.md|skill-package|export=",
  "toolkit__toolkit-guide|ext:toolkit:skills/toolkit-guide/SKILL.md|extension:toolkit:toolkit-extension|skills/toolkit__toolkit-guide/SKILL.md|skill-package|export=",
];

const DYNAMIC_SKILL_KEYS = [
  "toolkit2__playbooks|ext:toolkit2:skills/playbooks.mjs|extension:toolkit2:toolkit-extension|skills/toolkit2__playbooks.mjs|module|export=|events=session.started",
  "toolkit__playbooks|ext:toolkit:skills/playbooks.mjs|extension:toolkit:toolkit-extension|skills/toolkit__playbooks.mjs|module|export=|events=session.started",
];

const INSTRUCTION_KEYS = [
  "instructions|instructions.md|application|instructions.md|markdown|export=",
  "toolkit2__policy|ext:toolkit2:instructions/policy.md|extension:toolkit2:toolkit-extension|instructions/toolkit2__policy.md|markdown|export=",
  "toolkit__policy|ext:toolkit:instructions/policy.md|extension:toolkit:toolkit-extension|instructions/toolkit__policy.md|markdown|export=",
];

const KERNEL_FRAMEWORK_KEYS = [
  "load_skill|eve.framework-defaults:tools/load_skill.ts|framework:eve.framework-defaults|tools/load_skill.ts|module|export=",
];

const KERNEL_NATIVE_KEYS = [
  "agent|tools/agent.ts",
  "ask_question|tools/ask_question.ts",
  "final_output|tools/final_output.ts",
  "task_cancel|tools/task_cancel.ts",
  "task_update|tools/task_update.ts",
  "web_search|tools/web_search.ts",
];

const CHANNEL_KEYS = [
  "GET /eve/v1/connections/:name/callback/:attemptId/:token|eve.framework-root:channels/eve/v1/connections/callback/get.ts|framework:eve.framework-root|channels/eve/v1/connections/callback/get.ts|module|export=",
  "GET /eve/v1/connections/:name/callback/:token|eve.framework-root:channels/eve/v1/connections/callback/legacy/get.ts|framework:eve.framework-root|channels/eve/v1/connections/callback/legacy/get.ts|module|export=",
  "GET /eve/v1/health|channels/eve/v1/health.ts|application|channels/eve/v1/health.ts|module|export=",
  "GET /eve/v1/info|eve.framework-root:channels/eve.ts|framework:eve.framework-root|channels/eve.ts|module|export=",
  "GET /eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream|eve.framework-root:channels/eve.ts|framework:eve.framework-root|channels/eve.ts|module|export=",
  "GET /eve/v1/session/:sessionId/stream|eve.framework-root:channels/eve.ts|framework:eve.framework-root|channels/eve.ts|module|export=",
  "GET /|channels/home.ts|application|channels/home.ts|module|export=",
  "HEAD /eve/v1/health|channels/eve/v1/health.ts|application|channels/eve/v1/health.ts|module|export=",
  "POST /eve/v1/callback/:token|eve.framework-root:channels/eve/v1/callback/post.ts|framework:eve.framework-root|channels/eve/v1/callback/post.ts|module|export=",
  "POST /eve/v1/connections/:name/callback/:attemptId/:token|eve.framework-root:channels/eve/v1/connections/callback/post.ts|framework:eve.framework-root|channels/eve/v1/connections/callback/post.ts|module|export=",
  "POST /eve/v1/connections/:name/callback/:token|eve.framework-root:channels/eve/v1/connections/callback/legacy/post.ts|framework:eve.framework-root|channels/eve/v1/connections/callback/legacy/post.ts|module|export=",
  "POST /eve/v1/session/:sessionId/cancel|eve.framework-root:channels/eve.ts|framework:eve.framework-root|channels/eve.ts|module|export=",
  "POST /eve/v1/session/:sessionId/clear|eve.framework-root:channels/eve.ts|framework:eve.framework-root|channels/eve.ts|module|export=",
  "POST /eve/v1/session/:sessionId/compact|eve.framework-root:channels/eve.ts|framework:eve.framework-root|channels/eve.ts|module|export=",
  "POST /eve/v1/session/:sessionId/reset|eve.framework-root:channels/eve.ts|framework:eve.framework-root|channels/eve.ts|module|export=",
  "POST /eve/v1/session/:sessionId|eve.framework-root:channels/eve.ts|framework:eve.framework-root|channels/eve.ts|module|export=",
  "POST /eve/v1/session|eve.framework-root:channels/eve.ts|framework:eve.framework-root|channels/eve.ts|module|export=",
  "POST /eve/v1/task-input/:token|eve.framework-root:channels/eve/v1/task-input/post.ts|framework:eve.framework-root|channels/eve/v1/task-input/post.ts|module|export=",
];

const SHADOWED_ROUTE_KEYS = [
  "GET /|channels/zz-shadow.ts|application|channels/zz-shadow.ts|module|export=|pattern=/|winner=channels/home.ts",
];

const LOCAL_AGENT_KEYS = [
  "dynamic-worker|subagents/dynamic-worker|application|subagents/dynamic-worker|subagent|export=|node=subagents/dynamic-worker|parent=__root__|dynamic:agent.ts|application|agent.ts|module|export=:events=session.started|summary=0,0,0,false,0,0,7",
  "nested|ext:toolkit2:subagents/nested|extension:toolkit2:toolkit-extension|subagents/nested|subagent|export=|node=ext%3Atoolkit2%3Asubagents/worker::ext%3Atoolkit2%3Asubagents/nested|parent=ext%3Atoolkit2%3Asubagents/worker|static:Nested toolkit worker used to verify recursive extension provenance.|summary=0,0,0,true,0,0,7",
  "nested|ext:toolkit:subagents/nested|extension:toolkit:toolkit-extension|subagents/nested|subagent|export=|node=ext%3Atoolkit%3Asubagents/worker::ext%3Atoolkit%3Asubagents/nested|parent=ext%3Atoolkit%3Asubagents/worker|static:Nested toolkit worker used to verify recursive extension provenance.|summary=0,0,0,true,0,0,7",
  "task-reporter|subagents/task-reporter|application|subagents/task-reporter|subagent|export=|node=subagents/task-reporter|parent=__root__|static:Named worker used by background tasks and their task_update capability.|summary=0,0,0,true,0,0,7",
  "toolkit2__worker|ext:toolkit2:subagents/worker|extension:toolkit2:toolkit-extension|subagents/toolkit2__worker|subagent|export=|node=ext%3Atoolkit2%3Asubagents/worker|parent=__root__|static:Toolkit extension worker used to verify mounted subagent provenance.|summary=0,0,0,true,0,0,7",
  "toolkit__worker|ext:toolkit:subagents/worker|extension:toolkit:toolkit-extension|subagents/toolkit__worker|subagent|export=|node=ext%3Atoolkit%3Asubagents/worker|parent=__root__|static:Toolkit extension worker used to verify mounted subagent provenance.|summary=0,0,0,true,0,0,7",
];

const REMOTE_AGENT_KEYS = [
  "remote-inspection|subagents/remote-inspection.ts|application|subagents/remote-inspection.ts|subagent|export=|node=subagents/remote-inspection.ts|parent=__root__|config=subagents/remote-inspection.ts|application|subagents/remote-inspection.ts|module|export=|path=/eve/v1/session|url=https://remote-agent.invalid",
];

const SELECTED_COMPOSITION_KEYS = [
  "agent|agent.ts|application|agent.ts|module|export=",
  "channels/eve/v1/callback/post|eve.framework-root:channels/eve/v1/callback/post.ts|framework:eve.framework-root|channels/eve/v1/callback/post.ts|module|export=",
  "channels/eve/v1/connections/callback/get|eve.framework-root:channels/eve/v1/connections/callback/get.ts|framework:eve.framework-root|channels/eve/v1/connections/callback/get.ts|module|export=",
  "channels/eve/v1/connections/callback/legacy/get|eve.framework-root:channels/eve/v1/connections/callback/legacy/get.ts|framework:eve.framework-root|channels/eve/v1/connections/callback/legacy/get.ts|module|export=",
  "channels/eve/v1/connections/callback/legacy/post|eve.framework-root:channels/eve/v1/connections/callback/legacy/post.ts|framework:eve.framework-root|channels/eve/v1/connections/callback/legacy/post.ts|module|export=",
  "channels/eve/v1/connections/callback/post|eve.framework-root:channels/eve/v1/connections/callback/post.ts|framework:eve.framework-root|channels/eve/v1/connections/callback/post.ts|module|export=",
  "channels/eve/v1/health|channels/eve/v1/health.ts|application|channels/eve/v1/health.ts|module|export=",
  "channels/eve/v1/task-input/post|eve.framework-root:channels/eve/v1/task-input/post.ts|framework:eve.framework-root|channels/eve/v1/task-input/post.ts|module|export=",
  "channels/eve|eve.framework-root:channels/eve.ts|framework:eve.framework-root|channels/eve.ts|module|export=",
  "channels/home|channels/home.ts|application|channels/home.ts|module|export=",
  "channels/zz-shadow|channels/zz-shadow.ts|application|channels/zz-shadow.ts|module|export=",
  "extensions/gizmo|extensions/gizmo.ts|application|extensions/gizmo.ts|module|export=",
  "extensions/javascript|extensions/javascript.ts|application|extensions/javascript.ts|module|export=",
  "extensions/toolkit/extension|extensions/toolkit/extension.ts|application|extensions/toolkit/extension.ts|module|export=",
  "extensions/toolkit2/extension|extensions/toolkit2/extension.ts|application|extensions/toolkit2/extension.ts|module|export=",
  "instructions/toolkit2__policy|ext:toolkit2:instructions/policy.md|extension:toolkit2:toolkit-extension|instructions/toolkit2__policy.md|markdown|export=|extension-package",
  "instructions/toolkit__policy|ext:toolkit:instructions/policy.md|extension:toolkit:toolkit-extension|instructions/toolkit__policy.md|markdown|export=|extension-package",
  "instructions|instructions.md|application|instructions.md|markdown|export=|application",
  "instrumentation|eve.framework-root:instrumentation.ts|framework:eve.framework-root|instrumentation.ts|module|export=",
  "sandbox|sandbox.ts|application|sandbox.ts|module|export=",
  "skills/local-guide/SKILL|skills/local-guide/SKILL.md|application|skills/local-guide/SKILL.md|skill-package|export=|application",
  "skills/toolkit2__playbooks|ext:toolkit2:skills/playbooks.mjs|extension:toolkit2:toolkit-extension|skills/toolkit2__playbooks.mjs|module|export=",
  "skills/toolkit2__toolkit-guide/SKILL|ext:toolkit2:skills/toolkit-guide/SKILL.md|extension:toolkit2:toolkit-extension|skills/toolkit2__toolkit-guide/SKILL.md|skill-package|export=|extension-package",
  "skills/toolkit__playbooks|ext:toolkit:skills/playbooks.mjs|extension:toolkit:toolkit-extension|skills/toolkit__playbooks.mjs|module|export=",
  "skills/toolkit__toolkit-guide/SKILL|ext:toolkit:skills/toolkit-guide/SKILL.md|extension:toolkit:toolkit-extension|skills/toolkit__toolkit-guide/SKILL.md|skill-package|export=|extension-package",
  "subagents/dynamic-worker|subagents/dynamic-worker|application|subagents/dynamic-worker|subagent|export=|application",
  "subagents/remote-inspection|subagents/remote-inspection.ts|application|subagents/remote-inspection.ts|subagent|export=|application",
  "subagents/task-reporter|subagents/task-reporter|application|subagents/task-reporter|subagent|export=|application",
  "subagents/toolkit2__worker|ext:toolkit2:subagents/worker|extension:toolkit2:toolkit-extension|subagents/toolkit2__worker|subagent|export=|extension-package",
  "subagents/toolkit__worker|ext:toolkit:subagents/worker|extension:toolkit:toolkit-extension|subagents/toolkit__worker|subagent|export=|extension-package",
  "tools/bash|eve.framework-defaults:tools/bash.ts|framework:eve.framework-defaults|tools/bash.ts|module|export=",
  "tools/connection_search|eve.framework-defaults:tools/connection_search.ts|framework:eve.framework-defaults|tools/connection_search.ts|module|export=",
  "tools/gizmo__gizmo_budget|ext:gizmo:tools/gizmo_budget.mjs|extension:gizmo:gizmo-extension|tools/gizmo__gizmo_budget.mjs|module|export=",
  "tools/gizmo__gizmo_layout|ext:gizmo:tools/gizmo_layout.mjs|extension:gizmo:gizmo-extension|tools/gizmo__gizmo_layout.mjs|module|export=",
  "tools/gizmo__gizmo_search|tools/gizmo__gizmo_search.ts|application|tools/gizmo__gizmo_search.ts|module|export=",
  "tools/javascript__js_ping|ext:javascript:tools/js_ping.mjs|extension:javascript:js-only-extension|tools/javascript__js_ping.mjs|module|export=",
  "tools/load_skill|eve.framework-defaults:tools/load_skill.ts|framework:eve.framework-defaults|tools/load_skill.ts|module|export=",
  "tools/local_ping|tools/local_ping.ts|application|tools/local_ping.ts|module|export=",
  "tools/read_file|eve.framework-defaults:tools/read_file.ts|framework:eve.framework-defaults|tools/read_file.ts|module|export=",
  "tools/toolkit2__toolkit_budget|ext:toolkit2:tools/toolkit_budget.mjs|extension:toolkit2:toolkit-extension|tools/toolkit2__toolkit_budget.mjs|module|export=",
  "tools/toolkit2__toolkit_forecast|ext:toolkit2:tools/toolkit_forecast.mjs|extension:toolkit2:toolkit-extension|tools/toolkit2__toolkit_forecast.mjs|module|export=",
  "tools/toolkit2__toolkit_lookup|ext:toolkit2:tools/toolkit_lookup.mjs|extension:toolkit2:toolkit-extension|tools/toolkit2__toolkit_lookup.mjs|module|export=",
  "tools/toolkit2__toolkit_ping|ext:toolkit2:tools/toolkit_ping.mjs|extension:toolkit2:toolkit-extension|tools/toolkit2__toolkit_ping.mjs|module|export=",
  "tools/toolkit__toolkit_budget|ext:toolkit:tools/toolkit_budget.mjs|extension:toolkit:toolkit-extension|tools/toolkit__toolkit_budget.mjs|module|export=",
  "tools/toolkit__toolkit_forecast|ext:toolkit:tools/toolkit_forecast.mjs|extension:toolkit:toolkit-extension|tools/toolkit__toolkit_forecast.mjs|module|export=",
  "tools/toolkit__toolkit_lookup|ext:toolkit:tools/toolkit_lookup.mjs|extension:toolkit:toolkit-extension|tools/toolkit__toolkit_lookup.mjs|module|export=",
  "tools/toolkit__toolkit_ping|ext-override:toolkit:tools/toolkit_ping.ts|application|tools/toolkit__toolkit_ping.ts|module|export=",
  "tools/web_fetch|eve.framework-defaults:tools/web_fetch.ts|framework:eve.framework-defaults|tools/web_fetch.ts|module|export=",
  "tools/web_search|eve.framework-defaults:tools/web_search.ts|framework:eve.framework-defaults|tools/web_search.ts|module|export=",
  "tools/write_file|eve.framework-defaults:tools/write_file.ts|framework:eve.framework-defaults|tools/write_file.ts|module|export=",
];

const SHADOWED_COMPOSITION_KEYS = [
  "agent|eve.framework-defaults:agent.ts|framework:eve.framework-defaults|agent.ts|module|export=|framework-default|winner=agent.ts",
  "channels/eve/v1/health|eve.framework-root:channels/eve/v1/health.ts|framework:eve.framework-root|channels/eve/v1/health.ts|module|export=|framework-default|winner=channels/eve/v1/health.ts",
  "channels/home|eve.framework-root:channels/home.ts|framework:eve.framework-root|channels/home.ts|module|export=|framework-default|winner=channels/home.ts",
  "sandbox|eve.framework-defaults:sandbox.ts|framework:eve.framework-defaults|sandbox.ts|module|export=|framework-default|winner=sandbox.ts",
  "tools/gizmo__gizmo_search|ext:gizmo:tools/gizmo_search.mjs|extension:gizmo:gizmo-extension|tools/gizmo__gizmo_search.mjs|module|export=|extension-package|winner=tools/gizmo__gizmo_search.ts",
  "tools/todo|eve.framework-defaults:tools/todo.ts|framework:eve.framework-defaults|tools/todo.ts|module|export=|framework-default|winner=tools/todo.ts",
  "tools/toolkit__toolkit_ping|ext:toolkit:tools/toolkit_ping.mjs|extension:toolkit:toolkit-extension|tools/toolkit__toolkit_ping.mjs|module|export=|extension-package|winner=ext-override:toolkit:tools/toolkit_ping.ts",
];

const DISABLED_COMPOSITION_KEYS = [
  "tools/todo|tools/todo.ts|application|tools/todo.ts|module|export=|application",
];

export default defineEval({
  description:
    "The installed runtime exposes the complete canonical source graph through typed agent info.",
  async test(t) {
    const response = await t.target.fetch("/eve/v1/info");
    if (!response.ok) {
      throw new Error(`Agent info request failed with status ${String(response.status)}.`);
    }
    const info = AgentInfoResultSchema.parse(await response.json());
    const expectedMode = t.target.kind === "local" ? "development" : "production";

    t.check(
      {
        capabilities: info.capabilities,
        diagnostics: info.diagnostics,
        kind: info.kind,
        mode: info.mode,
        name: info.agent.name,
        nodeId: info.agent.nodeId,
        version: info.version,
      },
      equals({
        capabilities: { devRoutes: expectedMode === "development" },
        diagnostics: { errors: 0, warnings: 1 },
        kind: "eve-agent-info",
        mode: expectedMode,
        name: "extensions",
        nodeId: "__root__",
        version: 3,
      }),
    );
    t.check(info.agent.configSource, equals(authoredModule("agent.ts")));
    if (info.agent.model.routing.kind !== "dynamic") {
      throw new Error("Expected the root model to retain its compiled dynamic resolver.");
    }
    t.check(
      {
        reasoning: info.agent.model.reasoning,
        resolver: info.agent.model.routing.resolver,
      },
      equals({
        reasoning: "high",
        resolver: {
          ...authoredModule("agent.ts"),
          eventNames: ["step.started"],
        },
      }),
    );
    t.check(
      {
        backendKind: info.sandbox.backendKind,
        hasBootstrap: info.sandbox.hasBootstrap,
        hasOnSession: info.sandbox.hasOnSession,
        logicalPath: info.sandbox.logicalPath,
        owner: info.sandbox.owner,
        sourceHashIsCanonical: /^[a-f0-9]{64}$/.test(info.sandbox.sourceHash),
        sourceId: info.sandbox.sourceId,
        sourceKind: info.sandbox.sourceKind,
      },
      equals({
        backendKind: "just-bash",
        hasBootstrap: false,
        hasOnSession: false,
        logicalPath: "sandbox.ts",
        owner: { kind: "application" },
        sourceHashIsCanonical: true,
        sourceId: "sandbox.ts",
        sourceKind: "module",
      }),
    );
    t.check(
      {
        logicalPath: info.workspace.resourceRoot.logicalPath,
        resourceEntries: info.workspace.resourceRoot.rootEntries,
        rootEntries: info.workspace.rootEntries,
      },
      equals({
        logicalPath: "workspace-resources/__root__",
        resourceEntries: [],
        rootEntries: [],
      }),
    );

    t.check(sorted(info.tools.static.map(namedSourceKey)), equals(STATIC_TOOL_KEYS));
    t.check(sorted(info.tools.dynamic.map(dynamicSourceKey)), equals(DYNAMIC_TOOL_KEYS));
    t.check(sorted(info.skills.static.map(namedSourceKey)), equals(STATIC_SKILL_KEYS));
    t.check(sorted(info.skills.dynamic.map(dynamicSourceKey)), equals(DYNAMIC_SKILL_KEYS));
    t.check(sorted(info.instructions.static.map(namedSourceKey)), equals(INSTRUCTION_KEYS));
    t.check(info.instructions.dynamic, equals([]));
    t.check(
      sorted(info.kernel.frameworkSources.map(namedSourceKey)),
      equals(KERNEL_FRAMEWORK_KEYS),
    );
    t.check(
      sorted(info.kernel.native.map((entry) => `${entry.name}|${entry.canonicalPath}`)),
      equals(KERNEL_NATIVE_KEYS),
    );
    t.check(info.kernel.availability, equals("prepared-potential"));

    t.check(sorted(info.channels.map(channelKey)), equals(CHANNEL_KEYS));
    t.check(
      sorted(
        info.composition.routes.shadowed.map(
          (route) =>
            `${channelKey(route.loser)}|pattern=${route.pathPattern}|winner=${route.winningSourceId}`,
        ),
      ),
      equals(SHADOWED_ROUTE_KEYS),
    );
    t.check(info.connections, equals([]));
    t.check(info.hooks, equals([]));
    t.check(info.schedules, equals([]));

    t.check(sorted(info.subagents.local.map(localAgentKey)), equals(LOCAL_AGENT_KEYS));
    t.check(info.subagents.total, equals(LOCAL_AGENT_KEYS.length));
    t.check(sorted(info.remoteAgents.entries.map(remoteAgentKey)), equals(REMOTE_AGENT_KEYS));
    t.check(info.remoteAgents.total, equals(REMOTE_AGENT_KEYS.length));

    t.check(
      sorted(info.composition.selected.map((entry) => compositionKey(entry.slot, entry.source))),
      equals(SELECTED_COMPOSITION_KEYS),
    );
    t.check(
      sorted(
        info.composition.shadowed.map(
          (entry) => `${compositionKey(entry.slot, entry.source)}|winner=${entry.winningSourceId}`,
        ),
      ),
      equals(SHADOWED_COMPOSITION_KEYS),
    );
    t.check(
      sorted(info.composition.disabled.map((entry) => compositionKey(entry.slot, entry.source))),
      equals(DISABLED_COMPOSITION_KEYS),
    );

    const capabilityNames = [
      ...info.kernel.frameworkSources.map((entry) => entry.name),
      ...info.kernel.native.map((entry) => entry.name),
      ...info.tools.static.map((entry) => entry.name),
      ...info.tools.dynamic.map((entry) => entry.slug),
    ];
    t.check(new Set(capabilityNames).size, equals(capabilityNames.length));
    t.check(
      new Set(info.channels.map((entry) => `${entry.method} ${entry.urlPath}`)).size,
      equals(info.channels.length),
    );
    t.check(
      new Set(info.composition.selected.map((entry) => entry.slot)).size,
      equals(info.composition.selected.length),
    );
    const agentNodeIds = [
      ...info.subagents.local.map((entry) => entry.nodeId),
      ...info.remoteAgents.entries.map((entry) => entry.nodeId),
    ];
    t.check(new Set(agentNodeIds).size, equals(agentNodeIds.length));
  },
});

function authoredModule(sourceId: string) {
  return {
    logicalPath: sourceId,
    owner: { kind: "application" },
    sourceId,
    sourceKind: "module",
  };
}

function ownerKey(owner: AgentInfoOwner): string {
  switch (owner.kind) {
    case "application":
      return "application";
    case "framework":
      return `framework:${owner.feature}`;
    case "extension":
      return `extension:${owner.namespace}:${owner.packageName}`;
  }
}

function sourceKey(source: AgentInfoSource): string {
  const exportName = source.exportName === undefined ? "" : JSON.stringify(source.exportName);
  return `${source.sourceId}|${ownerKey(source.owner)}|${source.logicalPath}|${source.sourceKind}|export=${exportName}`;
}

function namedSourceKey(entry: AgentInfoSource & { readonly name: string }): string {
  return `${entry.name}|${sourceKey(entry)}`;
}

function dynamicSourceKey(entry: AgentInfoNamedDynamicResolverEntry): string {
  return `${entry.slug}|${sourceKey(entry)}|events=${entry.eventNames.join(",")}`;
}

function channelKey(entry: AgentInfoChannelEntry): string {
  return `${entry.method} ${entry.urlPath}|${sourceKey(entry)}`;
}

function localAgentKey(entry: AgentInfoSubagentEntry): string {
  const config =
    entry.configResolver === undefined
      ? `static:${String(entry.description)}`
      : `dynamic:${sourceKey(entry.configResolver)}:events=${entry.configResolver.eventNames.join(",")}`;
  const summary = [
    entry.summary.channels,
    entry.summary.connections,
    entry.summary.hooks,
    entry.summary.instructions,
    entry.summary.schedules,
    entry.summary.skills,
    entry.summary.tools,
  ].join(",");
  return `${entry.name}|${sourceKey(entry)}|node=${entry.nodeId}|parent=${entry.parentNodeId}|${config}|summary=${summary}`;
}

function remoteAgentKey(entry: AgentInfoRemoteAgentEntry): string {
  return `${entry.name}|${sourceKey(entry)}|node=${entry.nodeId}|parent=${entry.parentNodeId}|config=${sourceKey(entry.configResolver)}|path=${entry.path}|url=${String(entry.url)}`;
}

function compositionKey(
  slot: string,
  source: AgentInfoSource & { readonly layer?: string },
): string {
  return `${slot}|${sourceKey(source)}${source.layer === undefined ? "" : `|${source.layer}`}`;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}
