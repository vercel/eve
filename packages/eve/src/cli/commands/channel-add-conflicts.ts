import { join } from "node:path";

import type { ChannelKind } from "#setup/scaffold/index.js";
import type { DisabledChannelReasons } from "#setup/cli/index.js";

import { compileChannelDefinition } from "#compiler/normalize-channel.js";
import { createCompiledBindingNamespaceLoader } from "#compiler/load-binding-namespace.js";
import type { CompiledModuleBinding } from "#compiler/source-graph.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";

const SCAFFOLDED_WEB_CHANNEL_LOGICAL_PATH = "channels/eve.ts";
const SCAFFOLDED_SLACK_CHANNEL_LOGICAL_PATH = "channels/slack.ts";

/**
 * Existing authored registrations that affect the scaffolded channel picker
 * or would conflict with a generated channel module.
 */
export interface ExistingChannelRegistrations {
  readonly disabledChannelReasons: DisabledChannelReasons;
  readonly webRouteOwners: readonly string[];
  readonly slackOwners: readonly string[];
}

/**
 * Inspects compiled authored channels so custom filenames still disable the
 * scaffold option for the channel behavior they register.
 */
export async function inspectExistingChannelRegistrations(
  projectRoot: string,
): Promise<ExistingChannelRegistrations> {
  const agentRoot = join(projectRoot, "agent");
  const { manifest } = await discoverAgent({ agentRoot, appRoot: projectRoot });
  const webRouteOwners = new Set<string>();
  const slackOwners = new Set<string>();

  for (const source of manifest.channels) {
    const binding: CompiledModuleBinding = {
      backing: {
        externalDependencies: [],
        kind: "filesystem",
        sourcePath: join(agentRoot, source.logicalPath),
      },
      logicalPath: source.logicalPath,
      owner: { kind: "application" },
    };
    const compiled = await compileChannelDefinition(agentRoot, source, {
      binding,
      loadNamespace: createCompiledBindingNamespaceLoader({
        bindings: { [source.sourceId]: binding },
        registries: [],
      }),
    });
    if (compiled.kind !== "channel") continue;
    for (const definition of compiled.definitions) {
      if (definition.kind !== "channel") {
        continue;
      }
      if (definition.method === "POST" && definition.urlPath === EVE_SESSION_ROUTE_PATH) {
        webRouteOwners.add(source.logicalPath);
      }
      if (definition.adapterKind === "slack") {
        slackOwners.add(source.logicalPath);
      }
    }
  }

  const disabledChannelReasons: Partial<Record<ChannelKind, string>> = {};
  if (
    [...webRouteOwners].some((logicalPath) => logicalPath !== SCAFFOLDED_WEB_CHANNEL_LOGICAL_PATH)
  ) {
    disabledChannelReasons.web = `POST ${EVE_SESSION_ROUTE_PATH} already registered`;
  }
  if (slackOwners.size > 0) {
    disabledChannelReasons.slack = "Slack channel already registered";
  }

  return {
    disabledChannelReasons,
    webRouteOwners: [...webRouteOwners],
    slackOwners: [...slackOwners],
  };
}

/**
 * Rejects scaffolding when another authored module already owns behavior
 * emitted by the generated channel module.
 */
export function assertCanAddSelectedChannels(
  selectedChannels: readonly ChannelKind[],
  registrations: ExistingChannelRegistrations,
): void {
  if (selectedChannels.includes("web")) {
    const conflictingOwner = registrations.webRouteOwners.find(
      (logicalPath) => logicalPath !== SCAFFOLDED_WEB_CHANNEL_LOGICAL_PATH,
    );
    if (conflictingOwner !== undefined) {
      throw new Error(
        `Cannot scaffold Web Chat because agent/${conflictingOwner} already defines POST ${EVE_SESSION_ROUTE_PATH}. Web Chat scaffolds the same eve session routes.`,
      );
    }
  }

  if (selectedChannels.includes("slack")) {
    const conflictingOwner = registrations.slackOwners.find(
      (logicalPath) => logicalPath !== SCAFFOLDED_SLACK_CHANNEL_LOGICAL_PATH,
    );
    if (conflictingOwner !== undefined) {
      throw new Error(
        `Cannot scaffold Slack because agent/${conflictingOwner} already defines a Slack channel. Slack scaffolding would register the channel again.`,
      );
    }
  }
}
