import { createHash } from "node:crypto";

import { readDevelopmentEnvironmentHostValues } from "#cli/dev/environment.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createCompiledModuleBackingIdentity } from "#compiler/module-backing-identity.js";
import { computeChannelRouteRegistrations } from "#internal/nitro/host/channel-routes.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import type { CompiledWorkflowWorldPlan } from "#compiler/workflow-world-plan.js";
import { createCompiledExternalDependencyPlanIdentity } from "#compiler/external-dependency-plan.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

export async function computeDevelopmentHostFingerprint(
  host: PreparedDevelopmentApplicationHost,
): Promise<string> {
  const manifest = host.compileResult.manifest;
  const agentNodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  const payload = {
    agentName: manifest.config.name,
    bundler: {
      externalDependencyPlanIdentity: createCompiledExternalDependencyPlanIdentity(
        manifest.externalDependencyPlan,
      ),
      extensionScopes: agentNodes
        .flatMap((node) => node.extensionMounts)
        .map((mount) => ({
          packageNamespace: mount.packageNamespace,
          sourceRoot: mount.sourceRoot,
        }))
        .sort((left, right) => left.sourceRoot.localeCompare(right.sourceRoot)),
      sandboxBackends: [
        ...new Set(
          agentNodes
            .map((node) => node.sandbox.backendName)
            .filter((backendName): backendName is string => backendName !== undefined),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    },
    channels: computeChannelRouteRegistrations(host),
    environment: readDevelopmentEnvironmentHostValues(host.appRoot),
    instrumentation: await instrumentationFingerprint(manifest),
    workflow: {
      enabled: agentNodes.some((node) => node.workflowTool !== undefined),
      world: workflowWorldFingerprint(manifest.workflowWorld),
    },
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function instrumentationFingerprint(manifest: CompiledAgentManifest): Promise<unknown> {
  const plan = manifest.instrumentation;
  if (plan.kind === "none") return plan;
  if (plan.kind === "file") {
    return {
      entry: {
        ...plan.entry,
        identitySha256: await instrumentationSourceIdentity(manifest, plan.entry.source),
      },
      kind: plan.kind,
    };
  }
  return {
    entries: await Promise.all(
      plan.entries.map(async (entry) => ({
        ...entry,
        identitySha256: await instrumentationSourceIdentity(manifest, entry.source),
      })),
    ),
    kind: plan.kind,
  };
}

async function instrumentationSourceIdentity(
  manifest: CompiledAgentManifest,
  source: ModuleSourceRef,
): Promise<string> {
  const binding = manifest.bindings[source.sourceId];
  if (binding === undefined || binding.logicalPath !== source.logicalPath) {
    throw new Error(
      `Compiled instrumentation source "${source.sourceId}" is missing its exact module binding.`,
    );
  }
  return await createCompiledModuleBackingIdentity(
    binding.backing,
    manifest.externalDependencyPlan,
  );
}

function workflowWorldFingerprint(plan: CompiledWorkflowWorldPlan): unknown {
  return plan.kind === "native"
    ? plan
    : {
        identitySha256: plan.backing.identitySha256,
        kind: plan.kind,
        packageName: plan.packageName,
        selection: plan.selection,
      };
}
