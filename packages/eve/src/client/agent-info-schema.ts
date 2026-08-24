import { z } from "#compiled/zod/index.js";
import {
  ALLOWED_DYNAMIC_INSTRUCTION_EVENTS,
  ALLOWED_DYNAMIC_MODEL_EVENTS,
  ALLOWED_DYNAMIC_SKILL_EVENTS,
  ALLOWED_DYNAMIC_SUBAGENT_EVENTS,
  ALLOWED_DYNAMIC_TOOL_EVENTS,
} from "#shared/dynamic-tool-definition.js";

import {
  addCustomIssue,
  addDuplicateIssues,
  readRouteIdentity,
  sameSourceProjection,
  slotBelongsToFamily,
  validateAgentGraph,
} from "#client/agent-info-schema-semantics.js";

import {
  agentModel,
  channel,
  compositionSource,
  connection,
  dynamicResolver,
  entry,
  hook,
  instructions,
  kernelNativeCapability,
  localSubagent,
  moduleSource,
  namedDynamicResolver,
  owner,
  remoteAgent,
  sandbox,
  schedule,
  selectedCompositionSource,
  shadowedChannelRoute,
  skill,
  source,
  tool,
  workspaceResourceRoot,
} from "#client/agent-info-resource-schemas.js";

/** Runtime contract for the complete `GET /eve/v1/info` response. */
export const AgentInfoResultSchema = z
  .object({
    agent: z
      .object({
        agentRoot: z.string(),
        appRoot: z.string(),
        configSource: moduleSource,
        description: z.string().optional(),
        model: agentModel,
        name: z.string(),
        nodeId: z.string(),
        outputSchema: z.unknown().optional(),
      })
      .strict(),
    capabilities: z.object({ devRoutes: z.boolean() }).strict(),
    channels: z.array(channel),
    composition: z
      .object({
        disabled: z.array(
          z
            .object({
              slot: z.string(),
              source: compositionSource,
            })
            .strict(),
        ),
        routes: z.object({ shadowed: z.array(shadowedChannelRoute) }).strict(),
        selected: z.array(selectedCompositionSource),
        shadowed: z.array(
          z
            .object({
              slot: z.string(),
              source: compositionSource,
              winningSourceId: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
    connections: z.array(connection),
    diagnostics: z
      .object({
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
      })
      .strict(),
    hooks: z.array(hook),
    instructions: z
      .object({
        dynamic: z.array(namedDynamicResolver),
        static: z.array(instructions),
      })
      .strict(),
    kernel: z
      .object({
        availability: z.literal("prepared-potential"),
        frameworkSources: z.array(tool),
        native: z.array(kernelNativeCapability),
      })
      .strict(),
    kind: z.literal("eve-agent-info"),
    mode: z.enum(["development", "production"]),
    remoteAgents: z
      .object({
        entries: z.array(remoteAgent),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    sandbox,
    schedules: z.array(schedule),
    skills: z
      .object({
        dynamic: z.array(namedDynamicResolver),
        static: z.array(skill),
      })
      .strict(),
    subagents: z
      .object({
        local: z.array(localSubagent),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    tools: z
      .object({
        dynamic: z.array(namedDynamicResolver),
        static: z.array(tool),
      })
      .strict(),
    version: z.literal(3),
    workspace: z
      .object({
        resourceRoot: workspaceResourceRoot,
        rootEntries: z.array(z.string()),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.subagents.total !== result.subagents.local.length) {
      context.addIssue({
        code: "custom",
        message: "Local subagent total must equal the number of local entries.",
        path: ["subagents", "total"],
      });
    }
    if (result.remoteAgents.total !== result.remoteAgents.entries.length) {
      context.addIssue({
        code: "custom",
        message: "Remote agent total must equal the number of remote entries.",
        path: ["remoteAgents", "total"],
      });
    }
    if (
      result.workspace.rootEntries.length !== result.workspace.resourceRoot.rootEntries.length ||
      result.workspace.rootEntries.some(
        (entry, index) => entry !== result.workspace.resourceRoot.rootEntries[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Workspace root entries must match the compiled resource root.",
        path: ["workspace", "rootEntries"],
      });
    }

    addDuplicateIssues(
      [
        ...result.kernel.frameworkSources.map((entry, index) => ({
          identity: entry.name,
          path: ["kernel", "frameworkSources", index] as const,
        })),
        ...result.kernel.native.map((entry, index) => ({
          identity: entry.name,
          path: ["kernel", "native", index] as const,
        })),
        ...result.tools.static.map((entry, index) => ({
          identity: entry.name,
          path: ["tools", "static", index] as const,
        })),
        ...result.tools.dynamic.map((entry, index) => ({
          identity: entry.slug,
          path: ["tools", "dynamic", index] as const,
        })),
        ...result.subagents.local.flatMap((entry, index) =>
          entry.parentNodeId === result.agent.nodeId
            ? [
                {
                  identity: entry.name,
                  path: ["subagents", "local", index] as const,
                },
              ]
            : [],
        ),
        ...result.remoteAgents.entries.flatMap((entry, index) =>
          entry.parentNodeId === result.agent.nodeId
            ? [
                {
                  identity: entry.name,
                  path: ["remoteAgents", "entries", index] as const,
                },
              ]
            : [],
        ),
      ],
      "Active capability names must be unique.",
      context,
    );
    addDuplicateIssues(
      [
        ...result.skills.static.map((entry, index) => ({
          identity: entry.name,
          path: ["skills", "static", index] as const,
        })),
        ...result.skills.dynamic.map((entry, index) => ({
          identity: entry.slug,
          path: ["skills", "dynamic", index] as const,
        })),
      ],
      "Active skill names must be unique.",
      context,
    );
    addDuplicateIssues(
      [
        ...result.instructions.static.map((entry, index) => ({
          identity: entry.name,
          path: ["instructions", "static", index] as const,
        })),
        ...result.instructions.dynamic.map((entry, index) => ({
          identity: entry.slug,
          path: ["instructions", "dynamic", index] as const,
        })),
      ],
      "Active instructions names must be unique.",
      context,
    );
    addDuplicateIssues(
      result.connections.map((entry, index) => ({
        identity: entry.connectionName,
        path: ["connections", index] as const,
      })),
      "Active connection names must be unique.",
      context,
    );
    addDuplicateIssues(
      result.hooks.map((entry, index) => ({
        identity: entry.slug,
        path: ["hooks", index] as const,
      })),
      "Active hook names must be unique.",
      context,
    );
    addDuplicateIssues(
      result.schedules.map((entry, index) => ({
        identity: entry.name,
        path: ["schedules", index] as const,
      })),
      "Active schedule names must be unique.",
      context,
    );

    const effectiveRoutes = result.channels.flatMap((entry, index) => {
      const identity = readRouteIdentity(entry.method, entry.urlPath, ["channels", index], context);
      return identity === undefined
        ? []
        : [{ entry, identity, path: ["channels", index] as const }];
    });
    addDuplicateIssues(
      effectiveRoutes,
      "Effective channel route identities must be unique.",
      context,
    );
    validateAgentGraph(result, context);

    const eventSets = [
      ...(result.agent.model.routing.kind === "dynamic"
        ? [
            {
              allowedEventNames: ALLOWED_DYNAMIC_MODEL_EVENTS,
              eventNames: result.agent.model.routing.resolver.eventNames,
              kind: "model resolver",
              path: ["agent", "model", "routing", "resolver", "eventNames"] as const,
            },
          ]
        : []),
      ...result.tools.dynamic.map((entry, index) => ({
        allowedEventNames: ALLOWED_DYNAMIC_TOOL_EVENTS,
        eventNames: entry.eventNames,
        kind: "tool resolver",
        path: ["tools", "dynamic", index, "eventNames"] as const,
      })),
      ...result.skills.dynamic.map((entry, index) => ({
        allowedEventNames: ALLOWED_DYNAMIC_SKILL_EVENTS,
        eventNames: entry.eventNames,
        kind: "skill resolver",
        path: ["skills", "dynamic", index, "eventNames"] as const,
      })),
      ...result.instructions.dynamic.map((entry, index) => ({
        allowedEventNames: ALLOWED_DYNAMIC_INSTRUCTION_EVENTS,
        eventNames: entry.eventNames,
        kind: "instructions resolver",
        path: ["instructions", "dynamic", index, "eventNames"] as const,
      })),
      ...result.hooks.map((entry, index) => ({
        allowedEventNames: undefined,
        eventNames: entry.eventNames,
        kind: "hook",
        path: ["hooks", index, "eventNames"] as const,
      })),
      ...result.subagents.local.flatMap((entry, index) =>
        entry.configResolver === undefined
          ? []
          : [
              {
                allowedEventNames: ALLOWED_DYNAMIC_SUBAGENT_EVENTS,
                eventNames: entry.configResolver.eventNames,
                kind: "subagent config resolver",
                path: ["subagents", "local", index, "configResolver", "eventNames"] as const,
              },
            ],
      ),
    ];
    for (const eventSet of eventSets) {
      for (const [index, eventName] of eventSet.eventNames.entries()) {
        if (
          eventSet.allowedEventNames !== undefined &&
          !eventSet.allowedEventNames.has(eventName)
        ) {
          addCustomIssue(
            `The ${eventSet.kind} declares unsupported event "${eventName}".`,
            [...eventSet.path, index],
            context,
          );
        }
      }
      addDuplicateIssues(
        eventSet.eventNames.map((eventName, index) => ({
          identity: eventName,
          path: [...eventSet.path, index],
        })),
        "Dynamic and hook event names must be unique within each source.",
        context,
      );
    }

    const selectedBySlot = new Map<string, (typeof result.composition.selected)[number]>();
    const selectedBySourceId = new Map<string, AgentInfoSource>();
    const selectedSlotBySourceId = new Map<string, string>();
    for (const [index, selected] of result.composition.selected.entries()) {
      const path = ["composition", "selected", index] as const;
      if (selectedBySlot.has(selected.slot)) {
        addCustomIssue("Composition source slots must have exactly one winner.", path, context);
      } else {
        selectedBySlot.set(selected.slot, selected);
      }
      if (selectedBySourceId.has(selected.source.sourceId)) {
        addCustomIssue("Composition source IDs must be selected at most once.", path, context);
      } else {
        selectedBySourceId.set(selected.source.sourceId, selected.source);
        selectedSlotBySourceId.set(selected.source.sourceId, selected.slot);
      }
    }

    const winnerBySlot = new Map(
      [...selectedBySlot].map(([slot, selected]) => [slot, selected.source.sourceId] as const),
    );
    const winnerSourceIds = new Set(selectedBySourceId.keys());
    for (const [index, disabled] of result.composition.disabled.entries()) {
      const path = ["composition", "disabled", index] as const;
      if (winnerBySlot.has(disabled.slot)) {
        addCustomIssue(
          "Composition source slots cannot be both selected and disabled.",
          path,
          context,
        );
      } else {
        winnerBySlot.set(disabled.slot, disabled.source.sourceId);
      }
      if (winnerSourceIds.has(disabled.source.sourceId)) {
        addCustomIssue("Effective composition source IDs must be unique.", path, context);
      } else {
        winnerSourceIds.add(disabled.source.sourceId);
      }
    }

    const shadowedSourceIds = new Set<string>();
    const shadowedLayersBySlot = new Map<string, Set<string>>();
    for (const [index, shadowed] of result.composition.shadowed.entries()) {
      const path = ["composition", "shadowed", index] as const;
      const winnerSourceId = winnerBySlot.get(shadowed.slot);
      if (winnerSourceId === undefined || winnerSourceId !== shadowed.winningSourceId) {
        addCustomIssue(
          "Every shadowed source must reference the effective winner for its slot.",
          path,
          context,
        );
      }
      if (
        shadowed.source.sourceId === shadowed.winningSourceId ||
        winnerSourceIds.has(shadowed.source.sourceId)
      ) {
        addCustomIssue("An effective source cannot also be shadowed.", path, context);
      }
      if (shadowedSourceIds.has(shadowed.source.sourceId)) {
        addCustomIssue("Shadowed source IDs must be unique.", path, context);
      } else {
        shadowedSourceIds.add(shadowed.source.sourceId);
      }
      const layers = shadowedLayersBySlot.get(shadowed.slot) ?? new Set<string>();
      if (layers.has(shadowed.source.layer)) {
        addCustomIssue(
          "A composition slot cannot shadow more than one source from the same layer.",
          path,
          context,
        );
      } else {
        layers.add(shadowed.source.layer);
        shadowedLayersBySlot.set(shadowed.slot, layers);
      }
    }

    const activeSources: {
      readonly path: readonly (number | string)[];
      readonly source: AgentInfoSource;
    }[] = [
      { path: ["agent", "configSource"], source: result.agent.configSource },
      { path: ["sandbox"], source: result.sandbox },
      ...result.kernel.frameworkSources.map((source, index) => ({
        path: ["kernel", "frameworkSources", index],
        source,
      })),
      ...result.tools.static.map((source, index) => ({
        path: ["tools", "static", index],
        source,
      })),
      ...result.tools.dynamic.map((source, index) => ({
        path: ["tools", "dynamic", index],
        source,
      })),
      ...result.skills.static.map((source, index) => ({
        path: ["skills", "static", index],
        source,
      })),
      ...result.skills.dynamic.map((source, index) => ({
        path: ["skills", "dynamic", index],
        source,
      })),
      ...result.instructions.static.map((source, index) => ({
        path: ["instructions", "static", index],
        source,
      })),
      ...result.instructions.dynamic.map((source, index) => ({
        path: ["instructions", "dynamic", index],
        source,
      })),
      ...result.schedules.map((source, index) => ({ path: ["schedules", index], source })),
      ...result.connections.map((source, index) => ({ path: ["connections", index], source })),
      ...result.hooks.map((source, index) => ({ path: ["hooks", index], source })),
      ...result.channels.map((source, index) => ({ path: ["channels", index], source })),
      ...result.composition.routes.shadowed.map((route, index) => ({
        path: ["composition", "routes", "shadowed", index, "loser"],
        source: route.loser,
      })),
      ...result.subagents.local.flatMap((source, index) =>
        source.parentNodeId === result.agent.nodeId
          ? [{ path: ["subagents", "local", index], source }]
          : [],
      ),
      ...result.remoteAgents.entries.flatMap((source, index) =>
        source.parentNodeId === result.agent.nodeId
          ? [{ path: ["remoteAgents", "entries", index] as const, source }]
          : [],
      ),
    ];
    if (result.agent.model.routing.kind === "dynamic") {
      activeSources.push({
        path: ["agent", "model", "routing", "resolver"],
        source: result.agent.model.routing.resolver,
      });
    } else if (result.agent.model.source !== undefined) {
      activeSources.push({ path: ["agent", "model", "source"], source: result.agent.model.source });
    }

    for (const active of activeSources) {
      const selected = selectedBySourceId.get(active.source.sourceId);
      if (selected === undefined) {
        addCustomIssue(
          "Every active source must appear in selected composition.",
          active.path,
          context,
        );
      } else if (!sameSourceProjection(selected, active.source)) {
        addCustomIssue(
          "Active source provenance must match selected composition exactly.",
          active.path,
          context,
        );
      }
    }

    for (const [sources, family, allowRoot] of [
      [result.kernel.frameworkSources, "tools", false],
      [[...result.tools.static, ...result.tools.dynamic], "tools", false],
      [[...result.skills.static, ...result.skills.dynamic], "skills", false],
      [[...result.instructions.static, ...result.instructions.dynamic], "instructions", true],
      [result.schedules, "schedules", false],
      [result.connections, "connections", false],
      [result.hooks, "hooks", false],
      [result.channels, "channels", false],
      [result.composition.routes.shadowed.map((route) => route.loser), "channels", false],
    ] as const) {
      for (const source of sources) {
        const slot = selectedSlotBySourceId.get(source.sourceId);
        if (slot === undefined || slotBelongsToFamily(slot, family, allowRoot)) continue;
        addCustomIssue(
          `Active ${family} source must be selected from a ${family} composition slot.`,
          ["composition", "selected"],
          context,
        );
      }
    }

    const modelSource =
      result.agent.model.routing.kind === "dynamic"
        ? result.agent.model.routing.resolver
        : result.agent.model.source;
    if (
      modelSource !== undefined &&
      !sameSourceProjection(result.agent.configSource, modelSource)
    ) {
      addCustomIssue(
        "Source-backed model provenance must exactly match the selected config source.",
        ["agent", "model"],
        context,
      );
    }

    if (selectedBySlot.get("agent")?.source.sourceId !== result.agent.configSource.sourceId) {
      addCustomIssue(
        'The selected "agent" slot must match the projected config source.',
        ["agent", "configSource"],
        context,
      );
    }
    if (selectedBySlot.get("sandbox")?.source.sourceId !== result.sandbox.sourceId) {
      addCustomIssue(
        'The selected "sandbox" slot must match the projected sandbox source.',
        ["sandbox"],
        context,
      );
    }
    const directSubagents = [
      ...result.subagents.local.flatMap((entry, index) =>
        entry.parentNodeId === result.agent.nodeId
          ? [{ entry, path: ["subagents", "local", index] as const }]
          : [],
      ),
      ...result.remoteAgents.entries.flatMap((entry, index) =>
        entry.parentNodeId === result.agent.nodeId
          ? [{ entry, path: ["remoteAgents", "entries", index] as const }]
          : [],
      ),
    ];
    for (const { entry, path } of directSubagents) {
      if (selectedBySlot.get(`subagents/${entry.name}`)?.source.sourceId !== entry.sourceId) {
        addCustomIssue(
          "Every root-owned subagent must match its selected subagent slot.",
          path,
          context,
        );
      }
    }
    const shadowedRouteIdentities: {
      readonly identity: string;
      readonly path: readonly (number | string)[];
    }[] = [];
    for (const [index, shadowed] of result.composition.routes.shadowed.entries()) {
      const path = ["composition", "routes", "shadowed", index] as const;
      const loserIdentity = readRouteIdentity(
        shadowed.loser.method,
        shadowed.loser.urlPath,
        [...path, "loser"],
        context,
      );
      const recordedIdentity = readRouteIdentity(
        shadowed.method,
        shadowed.pathPattern,
        path,
        context,
      );
      if (
        shadowed.method !== shadowed.loser.method ||
        loserIdentity === undefined ||
        recordedIdentity === undefined ||
        loserIdentity !== recordedIdentity
      ) {
        addCustomIssue(
          "A shadowed route record must exactly identify its loser route.",
          path,
          context,
        );
      }
      const winner = effectiveRoutes.find(
        (route) =>
          route.entry.sourceId === shadowed.winningSourceId && route.identity === recordedIdentity,
      );
      if (winner === undefined || shadowed.loser.sourceId === shadowed.winningSourceId) {
        addCustomIssue(
          "A shadowed route must reference a distinct effective route with the same identity.",
          path,
          context,
        );
      }
      if (recordedIdentity !== undefined) {
        shadowedRouteIdentities.push({
          identity: `${shadowed.loser.sourceId}\0${recordedIdentity}`,
          path,
        });
      }
    }
    addDuplicateIssues(shadowedRouteIdentities, "Shadowed route records must be unique.", context);
  });

type ReadonlyDeep<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyDeep<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyDeep<T[Key]> }
    : T;

export type AgentInfoOwner = ReadonlyDeep<z.output<typeof owner>>;
export type AgentInfoSource = ReadonlyDeep<z.output<typeof source>>;
export type AgentInfoEntry = ReadonlyDeep<z.output<typeof entry>>;
export type AgentInfoToolEntry = ReadonlyDeep<z.output<typeof tool>>;
export type AgentInfoDynamicResolverEntry = ReadonlyDeep<z.output<typeof dynamicResolver>>;
export type AgentInfoNamedDynamicResolverEntry = ReadonlyDeep<
  z.output<typeof namedDynamicResolver>
>;
export type AgentInfoTools = AgentInfoResult["tools"];
export type AgentInfoSkillEntry = ReadonlyDeep<z.output<typeof skill>>;
export type AgentInfoInstructionsEntry = ReadonlyDeep<z.output<typeof instructions>>;
export type AgentInfoInstructions = AgentInfoResult["instructions"];
export type AgentInfoScheduleEntry = ReadonlyDeep<z.output<typeof schedule>>;
export type AgentInfoSubagentEntry = ReadonlyDeep<z.output<typeof localSubagent>>;
export type AgentInfoRemoteAgentEntry = ReadonlyDeep<z.output<typeof remoteAgent>>;
export type AgentInfoChannelEntry = ReadonlyDeep<z.output<typeof channel>>;
export type AgentInfoChannels = AgentInfoResult["channels"];
export type AgentInfoConnectionEntry = ReadonlyDeep<z.output<typeof connection>>;
export type AgentInfoHookEntry = ReadonlyDeep<z.output<typeof hook>>;
export type AgentInfoSandboxEntry = ReadonlyDeep<z.output<typeof sandbox>>;
export type AgentInfoKernelCapabilityEntry = ReadonlyDeep<z.output<typeof kernelNativeCapability>>;
export type AgentInfoShadowedChannelRoute = ReadonlyDeep<z.output<typeof shadowedChannelRoute>>;
export type AgentInfoComposition = AgentInfoResult["composition"];
export type AgentInfoResult = ReadonlyDeep<z.output<typeof AgentInfoResultSchema>>;
