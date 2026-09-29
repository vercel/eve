import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  type CompiledAgentManifest,
  type CompiledExtensionMount,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { defineExtension } from "#public/definitions/extension.js";
import {
  resolveExtensionMountConfigs,
  withExtensionConfigs,
} from "#runtime/extension-mount-configs.js";
import type { ResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

const regionSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value: { region: "us", ...(value as object) } }),
  },
};

function crmMount(sourceId: string): CompiledExtensionMount {
  return {
    externalDependencies: [],
    mountLogicalPath: "agent/extensions/crm.ts",
    mountSourceId: sourceId,
    namespace: "crm",
    packageName: "@acme/crm",
    packageNamespace: "@acme/crm",
    sourceRoot: "/node_modules/@acme/crm/extension",
  };
}

describe("resolveExtensionMountConfigs", () => {
  const crm = defineExtension({ config: regionSchema }, "@acme/crm-resolve");
  const manifest = {
    extensionMounts: [crmMount("root-crm")],
    subagents: [
      {
        agent: { extensionMounts: [] as CompiledExtensionMount[] },
        nodeId: "shipped",
        parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
      },
      {
        agent: { extensionMounts: [crmMount("bare-crm")] },
        nodeId: "bare",
        parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
      },
    ],
  } as CompiledAgentManifest;
  const moduleMap: CompiledModuleMap = {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: { "root-crm": { default: crm({ region: "eu" }) } },
      },
      bare: { modules: { "bare-crm": { default: crm } } },
    },
  };

  it("inherits the parent's config for a node without its own mount", () => {
    const configs = resolveExtensionMountConfigs(manifest, moduleMap);

    expect(configs.get("shipped")?.get("@acme/crm")).toEqual({ region: "eu" });
  });

  it("does not inherit the parent's config for a node's own bare mount", () => {
    const configs = resolveExtensionMountConfigs(manifest, moduleMap);

    expect(configs.get("bare")?.has("@acme/crm")).toBe(false);
  });
});

/** A session scope whose bundle serves a node with `extensionConfigs`. */
function sessionScope(extensionConfigs: ResolvedRuntimeAgentNode["extensionConfigs"]) {
  const ctx = new ContextContainer();
  ctx.set(BundleKey, {
    graph: { root: { extensionConfigs } as ResolvedRuntimeAgentNode },
  } as CompiledBundle);
  return ctx;
}

describe("extension config scoping", () => {
  it("gives a session node without a mount the defaults, not another agent's config", () => {
    const crm = defineExtension({ config: regionSchema }, "@acme/crm-session");
    crm({ region: "eu" });

    const config = contextStorage.run(sessionScope(new Map()), () => crm.config);

    expect(config).toEqual({ region: "us" });
  });

  it("reads ingress configs until a session bundle takes over", () => {
    const crm = defineExtension({ config: regionSchema }, "@acme/crm-ingress");
    crm({ region: "eu" });
    const session = sessionScope(new Map([["@acme/crm-ingress", { region: "sa" }]]));

    const seen = withExtensionConfigs(new Map([["@acme/crm-ingress", { region: "ap" }]]), () => ({
      ingress: crm.config,
      session: contextStorage.run(session, () => crm.config),
    }));

    expect(seen).toEqual({ ingress: { region: "ap" }, session: { region: "sa" } });
  });
});
